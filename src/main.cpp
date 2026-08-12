#include <Arduino.h>
#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <driver/pcnt.h>      // Legacy PCNT API
#include <driver/gpio.h>

// ==================== PIN DEFINITIONS ====================
#define PIN_UART_RX   18
#define PIN_I2C_SDA   8
#define PIN_I2C_SCL   9
#define PIN_PWM_OUT   10
#define PIN_CLOCK_IN  11
#define PIN_ADC_VOLT  1
#define PIN_BOOT_MON  4
#define PIN_RESET_MON 5
#define PIN_EN_MON    6
#define PIN_USB_DP    19
#define PIN_USB_DN    20

// ==================== CONFIGURATION ====================
const char *DEFAULT_SSID = "JCID_Diag_S3";
const char *DEFAULT_PASS = "admin1234";
String apSSID = DEFAULT_SSID;
String apPass = DEFAULT_PASS;

AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

// ==================== GLOBAL STATE ====================
unsigned long last100ms = 0, last1000ms = 0;
bool pwmEnabled = false;

// Legacy PCNT variables
pcnt_unit_t pcnt_unit = PCNT_UNIT_0;
volatile uint32_t pcnt_overflow_count = 0;
const int PCNT_H_LIM = 30000;
const uint8_t LEDC_CHANNEL = 0;
const uint8_t LEDC_RESOLUTION = 8;

// Sequence event queue (ISR safe)
#define EVENT_QUEUE_SIZE 64
struct SeqEvent {
  uint32_t timestamp;
  uint8_t pin;
  bool state;
};
volatile SeqEvent eventQueue[EVENT_QUEUE_SIZE];
volatile uint8_t eventHead = 0, eventTail = 0;

// UART buffer
char uartBuf[256];
uint16_t uartIdx = 0;

// JSON serialization buffer
char jsonBuf[512];

// ==================== ISR ====================
static void IRAM_ATTR pcnt_overflow_isr(void *arg) {
  pcnt_overflow_count++;
  pcnt_clear_intr_status(pcnt_unit);   // Fixed: use API function instead of PCNT register
}

void IRAM_ATTR handleSeqISR(uint8_t pin) {
  uint8_t nextHead = (eventHead + 1) % EVENT_QUEUE_SIZE;
  if (nextHead != eventTail) {
    eventQueue[eventHead].timestamp = millis();
    eventQueue[eventHead].pin = pin;
    eventQueue[eventHead].state = digitalRead(pin);
    eventHead = nextHead;
  }
}

void IRAM_ATTR isrBoot()  { handleSeqISR(PIN_BOOT_MON); }
void IRAM_ATTR isrReset() { handleSeqISR(PIN_RESET_MON); }
void IRAM_ATTR isrEn()    { handleSeqISR(PIN_EN_MON); }

// ==================== UTILS ====================
String htmlEscape(const String &input) {
  String out;
  out.reserve(input.length() + 20);
  for (char c : input) {
    switch (c) {
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '&': out += "&amp;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default: out += c;
    }
  }
  return out;
}

void saveConfig() {
  File f = LittleFS.open("/config.json", "w");
  if (!f) return;
  StaticJsonDocument<128> doc;
  doc["ssid"] = apSSID;
  doc["pass"] = apPass;
  serializeJson(doc, f);
  f.close();
}

void loadConfig() {
  if (!LittleFS.exists("/config.json")) return;
  File f = LittleFS.open("/config.json", "r");
  if (!f) return;
  StaticJsonDocument<128> doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) return;
  if (doc.containsKey("ssid")) apSSID = doc["ssid"].as<String>();
  if (doc.containsKey("pass")) apPass = doc["pass"].as<String>();
}

void restartDevice() {
  delay(500);
  ESP.restart();
}

void factoryReset() {
  LittleFS.remove("/config.json");
  delay(500);
  ESP.restart();
}

// ==================== HARDWARE INIT ====================
void initSafePins() {
  pinMode(PIN_PWM_OUT, INPUT);
  pinMode(PIN_I2C_SDA, INPUT);
  pinMode(PIN_I2C_SCL, INPUT);
  pinMode(PIN_ADC_VOLT, INPUT);
  pinMode(PIN_USB_DP, INPUT);
  pinMode(PIN_USB_DN, INPUT);
  pinMode(PIN_BOOT_MON, INPUT);
  pinMode(PIN_RESET_MON, INPUT);
  pinMode(PIN_EN_MON, INPUT);

  attachInterrupt(digitalPinToInterrupt(PIN_BOOT_MON), isrBoot, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_RESET_MON), isrReset, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_EN_MON), isrEn, CHANGE);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
}

void setupPCNT() {
  pcnt_config_t pcnt_config = {};
  pcnt_config.pulse_gpio_num = PIN_CLOCK_IN;
  pcnt_config.ctrl_gpio_num = -1;
  pcnt_config.lctrl_mode = PCNT_MODE_KEEP;
  pcnt_config.hctrl_mode = PCNT_MODE_KEEP;
  pcnt_config.pos_mode = PCNT_COUNT_INC;
  pcnt_config.neg_mode = PCNT_COUNT_DIS;
  pcnt_config.counter_h_lim = PCNT_H_LIM;
  pcnt_config.counter_l_lim = 0;
  pcnt_config.unit = pcnt_unit;
  pcnt_config.channel = PCNT_CHANNEL_0;

  pcnt_unit_config(&pcnt_config);

  pcnt_set_filter_value(pcnt_unit, 1);
  pcnt_filter_enable(pcnt_unit);

  pcnt_isr_register(pcnt_overflow_isr, NULL, 0, NULL);
  pcnt_intr_enable(pcnt_unit);
  pcnt_event_enable(pcnt_unit, PCNT_EVT_H_LIM);

  pcnt_counter_clear(pcnt_unit);
  pcnt_counter_resume(pcnt_unit);
}

void scanI2C(String &output) {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  gpio_pullup_dis((gpio_num_t)PIN_I2C_SDA);
  gpio_pullup_dis((gpio_num_t)PIN_I2C_SCL);

  output = "Scanned addresses:<br>";
  int count = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      output += "0x" + String(addr, HEX) + " ";
      count++;
      if (count % 8 == 0) output += "<br>";
    }
  }
  if (count == 0) output = "No devices found. Check power/pull-ups.";

  pinMode(PIN_I2C_SDA, INPUT);
  pinMode(PIN_I2C_SCL, INPUT);
}

void enablePWM(long freq, int duty) {
  if (pwmEnabled) return;
  ledcSetup(LEDC_CHANNEL, freq, LEDC_RESOLUTION);
  ledcAttachPin(PIN_PWM_OUT, LEDC_CHANNEL);
  ledcWrite(LEDC_CHANNEL, duty);
  pwmEnabled = true;
}

void disablePWM() {
  if (!pwmEnabled) return;
  ledcDetachPin(PIN_PWM_OUT);
  pinMode(PIN_PWM_OUT, INPUT);   // Safety: back to high-Z
  pwmEnabled = false;
}

// ==================== WEBSOCKET HANDLER ====================
void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type,
               void *arg, uint8_t *data, size_t len) {
  if (type == WS_EVT_DATA) {
    AwsFrameInfo *info = (AwsFrameInfo *)arg;
    if (info->final && info->opcode == WS_TEXT) {
      data[len] = 0;
      StaticJsonDocument<256> doc;
      DeserializationError err = deserializeJson(doc, (char *)data);
      if (err) return;

      String cmd = doc["cmd"];
      if (cmd == "baud") {
        long b = doc["val"] | 115200;
        if (b >= 300 && b <= 2000000) {
          Serial1.end();
          Serial1.begin(b, SERIAL_8N1, PIN_UART_RX, -1);
        }
      } else if (cmd == "i2c") {
        String result;
        scanI2C(result);
        StaticJsonDocument<512> res;
        res["type"] = "i2c";
        res["val"] = result;
        serializeJson(res, jsonBuf);
        client->text(jsonBuf);
      } else if (cmd == "pwm") {
        int en = doc["en"];
        if (en == 1) {
          long freq = doc["f"];
          int duty = doc["d"];
          if (freq >= 1 && freq <= 100000 && duty >= 0 && duty <= 255) {
            enablePWM(freq, duty);
          }
        } else {
          disablePWM();
        }
      } else if (cmd == "saveconfig") {
        const char *ssid = doc["ssid"];
        const char *pass = doc["pass"];
        if (ssid && pass) {
          apSSID = String(ssid);
          apPass = String(pass);
          saveConfig();
          client->text("{\"type\":\"msg\",\"val\":\"Saved. Restarting...\"}");
          restartDevice();
        }
      } else if (cmd == "restart") {
        client->text("{\"type\":\"msg\",\"val\":\"Restarting...\"}");
        restartDevice();
      } else if (cmd == "factoryreset") {
        client->text("{\"type\":\"msg\",\"val\":\"Factory reset. Restarting...\"}");
        factoryReset();
      } else if (cmd == "getconfig") {
        StaticJsonDocument<128> res;
        res["type"] = "config";
        res["ssid"] = apSSID;
        serializeJson(res, jsonBuf);
        client->text(jsonBuf);
      }
    }
  }
}

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed");
    return;
  }
  loadConfig();

  initSafePins();
  setupPCNT();

  Serial1.begin(115200, SERIAL_8N1, PIN_UART_RX, -1);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(apSSID.c_str(), apPass.c_str());

  server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
  ws.onEvent(onWsEvent);
  server.addHandler(&ws);
  server.begin();
}

// ==================== LOOP ====================
void loop() {
  ws.cleanupClients();
  unsigned long now = millis();

  // UART streaming
  while (Serial1.available()) {
    char c = Serial1.read();
    if (uartIdx < sizeof(uartBuf) - 1) {
      uartBuf[uartIdx++] = c;
    }
    if (c == '\n' || uartIdx >= sizeof(uartBuf) - 1) {
      uartBuf[uartIdx] = 0;
      String escaped = htmlEscape(String(uartBuf));
      StaticJsonDocument<512> doc;
      doc["type"] = "uart";
      doc["val"] = escaped;
      serializeJson(doc, jsonBuf);
      ws.textAll(jsonBuf);
      uartIdx = 0;
    }
  }

  // Sequence events - copy volatile struct fields manually
  while (eventHead != eventTail) {
    SeqEvent ev;
    ev.timestamp = eventQueue[eventTail].timestamp;
    ev.pin = eventQueue[eventTail].pin;
    ev.state = eventQueue[eventTail].state;
    eventTail = (eventTail + 1) % EVENT_QUEUE_SIZE;

    String pinName = (ev.pin == PIN_BOOT_MON) ? "BOOT" :
                     (ev.pin == PIN_RESET_MON) ? "RST" :
                     (ev.pin == PIN_EN_MON) ? "EN" : String(ev.pin);
    StaticJsonDocument<128> doc;
    doc["type"] = "seq";
    doc["time"] = ev.timestamp;
    doc["pin"] = pinName;
    doc["state"] = ev.state;
    serializeJson(doc, jsonBuf);
    ws.textAll(jsonBuf);
  }

  // 100ms tasks
  if (now - last100ms >= 100) {
    last100ms = now;
    uint32_t mv = analogReadMilliVolts(PIN_ADC_VOLT);
    float voltage = mv / 1000.0;
    bool dp = digitalRead(PIN_USB_DP);
    bool dn = digitalRead(PIN_USB_DN);

    StaticJsonDocument<128> vdoc;
    vdoc["type"] = "v";
    vdoc["val"] = voltage;
    serializeJson(vdoc, jsonBuf);
    ws.textAll(jsonBuf);

    StaticJsonDocument<128> udoc;
    udoc["type"] = "usb";
    udoc["dp"] = dp;
    udoc["dn"] = dn;
    serializeJson(udoc, jsonBuf);
    ws.textAll(jsonBuf);
  }

  // 1000ms tasks
  if (now - last1000ms >= 1000) {
    last1000ms = now;

    int16_t count = 0;
    pcnt_get_counter_value(pcnt_unit, &count);
    pcnt_counter_clear(pcnt_unit);
    uint32_t ov = pcnt_overflow_count;
    pcnt_overflow_count = 0;
    uint32_t hz = ov * PCNT_H_LIM + count;

    StaticJsonDocument<128> cdoc;
    cdoc["type"] = "clk";
    cdoc["val"] = hz;
    serializeJson(cdoc, jsonBuf);
    ws.textAll(jsonBuf);

    float temp = temperatureRead();
    StaticJsonDocument<256> sys;
    sys["type"] = "sys";
    sys["heap"] = ESP.getFreeHeap();
    sys["min_heap"] = ESP.getMinFreeHeap();
    sys["psram_free"] = ESP.getFreePsram();
    sys["psram_total"] = ESP.getPsramSize();
    sys["temp"] = temp;
    sys["wifi_clients"] = WiFi.softAPgetStationNum();
    sys["ssid"] = apSSID;
    serializeJson(sys, jsonBuf);
    ws.textAll(jsonBuf);
  }
}
