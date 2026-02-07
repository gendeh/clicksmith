#include <Geode/Geode.hpp>
#include <Geode/modify/GJBaseGameLayer.hpp>
#include <Geode/modify/PlayLayer.hpp>
#include <Geode/modify/PlayerObject.hpp>
#include <matjson.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "Ws2_32.lib")
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

using namespace geode::prelude;

namespace {
constexpr int kStatusPort = 27737;
// Allow tiny scheduling slack to avoid one-frame late dispatch jitter.
constexpr double kMsEpsilon = 1.0;

#ifdef _WIN32
using SocketHandle = SOCKET;
const SocketHandle kInvalidSocket = INVALID_SOCKET;
#else
using SocketHandle = int;
const SocketHandle kInvalidSocket = -1;
#endif

struct MacroEvent {
  double t_ms = 0.0;
  PlayerButton button = PlayerButton::Jump;
  bool down = false;
  bool player2 = false;
};

struct MacroData {
  std::vector<MacroEvent> events;
  double duration_ms = 0.0;
  double start_ms = 0.0;
};

std::mutex gMacroMutex;
std::vector<MacroEvent> gRecordingEvents;
MacroData gLastMacro;
std::vector<MacroEvent> gPendingReplayEvents;
std::vector<MacroEvent> gReplayEvents;

std::atomic<bool> gRecordArmed{false};
std::atomic<bool> gTakeoverArmed{false};
std::atomic<bool> gRecordActive{false};
std::atomic<bool> gRecordStopRequested{false};
std::atomic<bool> gRecordComplete{false};

std::atomic<bool> gReplayRequested{false};
std::atomic<bool> gReplayActive{false};
std::atomic<bool> gReplayStopRequested{false};
std::atomic<bool> gReplayArmed{false};
std::atomic<bool> gReplayDispatching{false};

PlayLayer* gActivePlayLayer = nullptr;
bool gInLevel = false;
bool gButtonDown[2][3] = {{false, false, false}, {false, false, false}};

// These are only accessed on the game thread.
double gGameTimeMs = 0.0;
double gRecordStartMs = 0.0;
double gReplayStartMs = 0.0;
std::size_t gReplayIndex = 0;
bool gRecordFromTakeover = false;
double gTakeoverStartMs = 0.0;
std::chrono::steady_clock::time_point gLastAttemptBoundaryAt = std::chrono::steady_clock::time_point::min();
bool gAttemptBoundaryPending = false;
bool gWasPaused = false;
double gPauseStartedGameMs = 0.0;

void startRecording();
void stopReplay();
void startReplay();

void closeSocket(SocketHandle handle) {
#ifdef _WIN32
  if (handle != kInvalidSocket) {
    closesocket(handle);
  }
#else
  if (handle >= 0) {
    close(handle);
  }
#endif
}

const char* buttonToString(PlayerButton button) {
  switch (button) {
    case PlayerButton::Left:
      return "left";
    case PlayerButton::Right:
      return "right";
    default:
      return "jump";
  }
}

int buttonIndex(PlayerButton button) {
  switch (button) {
    case PlayerButton::Left:
      return 1;
    case PlayerButton::Right:
      return 2;
    default:
      return 0;
  }
}

bool updateButtonState(PlayerButton button, bool down, bool player2) {
  const int p = player2 ? 1 : 0;
  const int b = buttonIndex(button);
  bool& state = gButtonDown[p][b];
  if (state == down) return false;
  state = down;
  return true;
}

bool stringToButton(std::string_view value, PlayerButton& out) {
  if (value == "jump" || value == "space") {
    out = PlayerButton::Jump;
    return true;
  }
  if (value == "left") {
    out = PlayerButton::Left;
    return true;
  }
  if (value == "right") {
    out = PlayerButton::Right;
    return true;
  }
  return false;
}

matjson::Value eventToJson(const MacroEvent& event) {
  auto obj = matjson::Value::object();
  obj["t_ms"] = event.t_ms;
  obj["button"] = buttonToString(event.button);
  obj["down"] = event.down;
  obj["player2"] = event.player2;
  return obj;
}

std::string buildStatusPayload() {
  auto payload = matjson::Value::object();
  payload["ok"] = true;
  payload["id"] = "geode-geometry-dash";
  payload["name"] = "Clicksmith Geode Adapter";
  payload["game"] = "Geometry Dash";
  payload["version"] = "0.2.0";
  auto caps = matjson::Value::array();
  caps.push("status");
  caps.push("record");
  caps.push("replay");
  payload["capabilities"] = caps;
  payload["tick_hz"] = 240;
  payload["record_active"] = gRecordActive.load();
  payload["record_armed"] = gRecordArmed.load();
  payload["record_complete"] = gRecordComplete.load();
  payload["replay_active"] = gReplayActive.load();
  payload["replay_armed"] = gReplayArmed.load();
  payload["replay_requested"] = gReplayRequested.load();
  payload["takeover_armed"] = gTakeoverArmed.load();
  return payload.dump(matjson::NO_INDENTATION);
}

struct HttpRequest {
  std::string method;
  std::string path;
  std::string body;
  bool chunked = false;
  std::size_t contentLength = 0;
};

struct HttpResponse {
  int status = 200;
  std::string body;
};

std::string buildHttpResponse(const HttpResponse& response) {
  std::ostringstream output;
  if (response.status == 200) {
    output << "HTTP/1.1 200 OK\r\n";
  } else if (response.status == 400) {
    output << "HTTP/1.1 400 Bad Request\r\n";
  } else if (response.status == 404) {
    output << "HTTP/1.1 404 Not Found\r\n";
  } else {
    output << "HTTP/1.1 500 Internal Server Error\r\n";
  }
  output << "Content-Type: application/json\r\n";
  output << "Content-Length: " << response.body.size() << "\r\n";
  output << "Connection: close\r\n";
  output << "Access-Control-Allow-Origin: *\r\n\r\n";
  output << response.body;
  return output.str();
}

std::string buildErrorPayload(const std::string& message) {
  auto payload = matjson::Value::object();
  payload["ok"] = false;
  payload["error"] = message;
  return payload.dump(matjson::NO_INDENTATION);
}

std::string decodeChunkedBody(const std::string& body) {
  std::string output;
  std::size_t offset = 0;
  while (offset < body.size()) {
    auto lineEnd = body.find("\r\n", offset);
    if (lineEnd == std::string::npos) break;
    std::string sizeHex = body.substr(offset, lineEnd - offset);
    std::size_t chunkSize = 0;
    try {
      chunkSize = std::stoul(sizeHex, nullptr, 16);
    } catch (...) {
      break;
    }
    offset = lineEnd + 2;
    if (chunkSize == 0) break;
    if (offset + chunkSize > body.size()) break;
    output.append(body.substr(offset, chunkSize));
    offset += chunkSize + 2;
  }
  return output;
}

bool parseHttpRequest(SocketHandle client, HttpRequest& outRequest) {
  std::string data;
  data.reserve(4096);
  std::string headerChunk;
  std::size_t headerEnd = std::string::npos;
  std::size_t contentLength = 0;
  bool chunked = false;
  bool headersParsed = false;

  char buffer[4096];
  while (true) {
#ifdef _WIN32
    const int received = recv(client, buffer, sizeof(buffer), 0);
#else
    const int received = static_cast<int>(recv(client, buffer, sizeof(buffer), 0));
#endif
    if (received <= 0) break;
    data.append(buffer, received);
    headerEnd = data.find("\r\n\r\n");
    if (headerEnd != std::string::npos) {
      if (!headersParsed) {
        headerChunk = data.substr(0, headerEnd);
        std::string lowerHeader = headerChunk;
        std::transform(lowerHeader.begin(), lowerHeader.end(), lowerHeader.begin(), [](unsigned char c) {
          return static_cast<char>(std::tolower(c));
        });

        auto contentPos = lowerHeader.find("content-length:");
        if (contentPos != std::string::npos) {
          auto lineEnd = lowerHeader.find("\r\n", contentPos);
          std::string value = headerChunk.substr(contentPos + 15, lineEnd - (contentPos + 15));
          try {
            contentLength = static_cast<std::size_t>(std::stoul(value));
          } catch (...) {
            contentLength = 0;
          }
        }
        if (lowerHeader.find("transfer-encoding: chunked") != std::string::npos) {
          chunked = true;
        }
        headersParsed = true;
      }
      std::size_t bodyStart = headerEnd + 4;
      if (!chunked && contentLength == 0) {
        break;
      } else if (!chunked && contentLength > 0) {
        std::size_t totalNeeded = bodyStart + contentLength;
        if (data.size() >= totalNeeded) break;
      } else if (chunked) {
        if (data.find("\r\n0\r\n\r\n", bodyStart) != std::string::npos) break;
      } else if (data.size() > bodyStart) {
        break;
      }
    }
  }

  if (data.empty()) return false;
  if (headerEnd == std::string::npos) return false;

  std::string requestLine;
  auto lineEnd = data.find("\r\n");
  if (lineEnd == std::string::npos) return false;
  requestLine = data.substr(0, lineEnd);

  std::istringstream lineStream(requestLine);
  lineStream >> outRequest.method;
  lineStream >> outRequest.path;
  if (outRequest.method.empty() || outRequest.path.empty()) return false;

  auto queryPos = outRequest.path.find('?');
  if (queryPos != std::string::npos) {
    outRequest.path = outRequest.path.substr(0, queryPos);
  }

  std::size_t bodyStart = headerEnd + 4;
  if (data.size() > bodyStart) {
    std::string rawBody = data.substr(bodyStart);
    if (contentLength > 0 && rawBody.size() >= contentLength) {
      outRequest.body = rawBody.substr(0, contentLength);
    } else if (chunked) {
      outRequest.body = decodeChunkedBody(rawBody);
    } else {
      outRequest.body = rawBody;
    }
  }
  outRequest.chunked = chunked;
  outRequest.contentLength = contentLength;

  return true;
}

bool parseEventsFromJson(const matjson::Value& root, std::vector<MacroEvent>& outEvents) {
  if (!root.isObject()) return false;
  auto eventsValue = root["events"];
  if (!eventsValue.isArray()) return false;
  auto arrRes = eventsValue.asArray();
  if (arrRes.isErr()) return false;
  auto arr = std::move(arrRes).unwrap();
  outEvents.clear();
  outEvents.reserve(arr.size());

  for (auto& item : arr) {
    if (!item.isObject()) continue;
    MacroEvent event;
    auto tRes = item["t_ms"].asDouble();
    if (tRes.isOk()) {
      event.t_ms = tRes.unwrap();
    } else {
      auto tIntRes = item["t_ms"].asInt();
      if (tIntRes.isOk()) {
        event.t_ms = static_cast<double>(tIntRes.unwrap());
      }
    }
    if (event.t_ms < 0.0) {
      event.t_ms = 0.0;
    }
    auto downRes = item["down"].asBool();
    if (downRes.isOk()) {
      event.down = downRes.unwrap();
    }
    auto player2Res = item["player2"].asBool();
    if (player2Res.isOk()) {
      event.player2 = player2Res.unwrap();
    }
    auto buttonRes = item["button"].asString();
    PlayerButton button = PlayerButton::Jump;
    if (buttonRes.isOk()) {
      const auto value = buttonRes.unwrap();
      if (!stringToButton(value, button)) {
        continue;
      }
    }
    event.button = button;
    outEvents.push_back(event);
  }

  std::sort(outEvents.begin(), outEvents.end(), [](const MacroEvent& a, const MacroEvent& b) {
    if (a.t_ms != b.t_ms) return a.t_ms < b.t_ms;
    return a.down && !b.down;
  });

  return true;
}

HttpResponse handleRecordStart() {
  if (gRecordActive.load()) {
    auto payload = matjson::Value::object();
    payload["ok"] = true;
    payload["state"] = "recording";
    return {200, payload.dump(matjson::NO_INDENTATION)};
  }
  gRecordActive.store(false);
  gRecordArmed.store(true);
  gTakeoverArmed.store(false);
  gRecordStopRequested.store(false);
  gRecordComplete.store(false);
  gRecordFromTakeover = false;
  gTakeoverStartMs = 0.0;
  auto payload = matjson::Value::object();
  payload["ok"] = true;
  payload["state"] = "armed";
  return {200, payload.dump(matjson::NO_INDENTATION)};
}

HttpResponse handleRecordStop() {
  if (!gRecordActive.load() && !gRecordArmed.load() && !gTakeoverArmed.load() && !gRecordComplete.load()) {
    return {400, buildErrorPayload("not_recording")};
  }

  if (!gRecordActive.load() && (gRecordArmed.load() || gTakeoverArmed.load())) {
    gRecordArmed.store(false);
    gTakeoverArmed.store(false);
    gRecordFromTakeover = false;
    gTakeoverStartMs = 0.0;
    MacroData snapshot;
    {
      std::lock_guard<std::mutex> lock(gMacroMutex);
      gRecordingEvents.clear();
      gLastMacro = snapshot;
    }
    auto payload = matjson::Value::object();
    payload["ok"] = true;
    payload["duration_ms"] = snapshot.duration_ms;
    payload["start_ms"] = snapshot.start_ms;
    payload["tick_hz"] = 240;
    payload["events"] = matjson::Value::array();
    return {200, payload.dump(matjson::NO_INDENTATION)};
  }
  gRecordStopRequested.store(true);

  bool completed = false;
  for (int i = 0; i < 200; i++) {
    if (gRecordComplete.load()) {
      completed = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }

  MacroData snapshot;
  if (!completed) {
    std::lock_guard<std::mutex> lock(gMacroMutex);
    snapshot.events = gRecordingEvents;
    snapshot.duration_ms = std::max(0.0, gGameTimeMs - gRecordStartMs);
    snapshot.start_ms = gRecordFromTakeover ? gTakeoverStartMs : gRecordStartMs;
    gLastMacro = snapshot;
    gRecordingEvents.clear();
    gRecordActive.store(false);
    gRecordArmed.store(false);
    gTakeoverArmed.store(false);
    gRecordComplete.store(false);
    gRecordFromTakeover = false;
    gTakeoverStartMs = 0.0;
  } else {
    std::lock_guard<std::mutex> lock(gMacroMutex);
    snapshot = gLastMacro;
    gRecordComplete.store(false);
  }

  auto payload = matjson::Value::object();
  payload["ok"] = true;
  payload["duration_ms"] = snapshot.duration_ms;
  payload["start_ms"] = snapshot.start_ms;
  payload["tick_hz"] = 240;
  auto arr = matjson::Value::array();
  for (const auto& event : snapshot.events) {
    arr.push(eventToJson(event));
  }
  payload["events"] = arr;
  return {200, payload.dump(matjson::NO_INDENTATION)};
}

HttpResponse handleReplayStart(const HttpRequest& request) {
  std::vector<MacroEvent> events;
  const bool requestHasBody = !request.body.empty();
  if (requestHasBody) {
    auto parsed = matjson::Value::parse(request.body);
    if (parsed.isErr()) {
      return {400, buildErrorPayload("invalid_json")};
    }
    if (!parseEventsFromJson(parsed.unwrap(), events)) {
      return {400, buildErrorPayload("invalid_events")};
    }
  }

  if (events.empty()) {
    // If the caller explicitly sent a replay payload, never fall back to
    // stale in-memory macro data.
    if (requestHasBody) {
      return {400, buildErrorPayload("no_events")};
    }
    std::lock_guard<std::mutex> lock(gMacroMutex);
    events = gLastMacro.events;
  }

  if (events.empty()) {
    return {400, buildErrorPayload("no_events")};
  }

  // Clear any stale replay state before arming a new replay.
  stopReplay();

  {
    std::lock_guard<std::mutex> lock(gMacroMutex);
    gPendingReplayEvents = std::move(events);
  }
  gReplayRequested.store(false);
  gReplayStopRequested.store(false);
  gReplayArmed.store(true);

  auto payload = matjson::Value::object();
  payload["ok"] = true;
  payload["state"] = "armed";
  return {200, payload.dump(matjson::NO_INDENTATION)};
}

HttpResponse handleReplayTakeover(const HttpRequest& request) {
  bool immediate = false;
  if (!request.body.empty()) {
    auto parsed = matjson::Value::parse(request.body);
    if (parsed.isOk()) {
      auto nowRes = parsed.unwrap()["immediate"].asBool();
      if (nowRes.isOk()) {
        immediate = nowRes.unwrap();
      }
    }
  }

  if (!gInLevel) {
    return {400, buildErrorPayload("not_in_level")};
  }

  if (immediate) {
    if (!gReplayActive.load()) {
      return {400, buildErrorPayload("not_replaying")};
    }
    double takeoverStartMs =
      gReplayActive.load() ? std::max(0.0, gGameTimeMs - gReplayStartMs) : std::max(0.0, gGameTimeMs);
    if (!gReplayEvents.empty()) {
      const double maxReplayMs = std::max(0.0, gReplayEvents.back().t_ms);
      takeoverStartMs = std::clamp(takeoverStartMs, 0.0, maxReplayMs);
    }
    gReplayRequested.store(false);
    gReplayStopRequested.store(false);
    stopReplay();
    startRecording();
    gRecordFromTakeover = true;
    gTakeoverStartMs = takeoverStartMs;
    auto payload = matjson::Value::object();
    payload["ok"] = true;
    payload["state"] = "recording";
    payload["immediate"] = true;
    return {200, payload.dump(matjson::NO_INDENTATION)};
  }

  if (!gReplayActive.load() && !gReplayRequested.load() && !gReplayArmed.load()) {
    return {400, buildErrorPayload("not_replaying")};
  }

  gTakeoverArmed.store(true);
  gRecordArmed.store(false);
  gRecordStopRequested.store(false);
  gRecordComplete.store(false);
  gRecordStartMs = gGameTimeMs;
  auto payload = matjson::Value::object();
  payload["ok"] = true;
  payload["state"] = "takeover_armed";
  return {200, payload.dump(matjson::NO_INDENTATION)};
}

HttpResponse handleReplayStop() {
  gReplayArmed.store(false);
  gReplayRequested.store(false);
  gReplayStopRequested.store(true);
  auto payload = matjson::Value::object();
  payload["ok"] = true;
  payload["state"] = "stopped";
  return {200, payload.dump(matjson::NO_INDENTATION)};
}

HttpResponse routeRequest(const HttpRequest& request) {
  if (request.method == "GET" && request.path == "/status") {
    return {200, buildStatusPayload()};
  }
  if (request.method == "POST" && request.path == "/record/start") {
    return handleRecordStart();
  }
  if (request.method == "POST" && request.path == "/record/stop") {
    return handleRecordStop();
  }
  if (request.method == "POST" && request.path == "/replay/start") {
    return handleReplayStart(request);
  }
  if (request.method == "POST" && request.path == "/replay/takeover") {
    return handleReplayTakeover(request);
  }
  if (request.method == "POST" && request.path == "/replay/stop") {
    return handleReplayStop();
  }
  return {404, buildErrorPayload("not_found")};
}

class AdapterServer {
 public:
  void start() {
    if (running.exchange(true)) return;
    worker = std::thread([this]() { run(); });
  }

  void stop() {
    if (!running.exchange(false)) return;
    closeSocket(listenSocket);
    listenSocket = kInvalidSocket;
    if (worker.joinable()) {
      worker.join();
    }
  }

  ~AdapterServer() {
    stop();
  }

 private:
  std::atomic<bool> running{false};
  std::thread worker;
  SocketHandle listenSocket = kInvalidSocket;

  void run() {
#ifdef _WIN32
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
      log::error("Clicksmith adapter: WSAStartup failed");
      running = false;
      return;
    }
#endif

    listenSocket = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listenSocket == kInvalidSocket) {
      log::error("Clicksmith adapter: socket create failed");
#ifdef _WIN32
      WSACleanup();
#endif
      running = false;
      return;
    }

    int opt = 1;
    setsockopt(listenSocket, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<char*>(&opt), sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(kStatusPort);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(listenSocket, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
      log::error("Clicksmith adapter: bind failed (port in use?)");
      closeSocket(listenSocket);
      listenSocket = kInvalidSocket;
#ifdef _WIN32
      WSACleanup();
#endif
      running = false;
      return;
    }

    if (listen(listenSocket, 4) < 0) {
      log::error("Clicksmith adapter: listen failed");
      closeSocket(listenSocket);
      listenSocket = kInvalidSocket;
#ifdef _WIN32
      WSACleanup();
#endif
      running = false;
      return;
    }

    log::info("Clicksmith adapter: listening on 127.0.0.1:{}", kStatusPort);

    while (running.load()) {
      fd_set readSet;
      FD_ZERO(&readSet);
      FD_SET(listenSocket, &readSet);
      timeval timeout{};
      timeout.tv_sec = 1;
      timeout.tv_usec = 0;

#ifdef _WIN32
      const int ready = select(0, &readSet, nullptr, nullptr, &timeout);
#else
      const int ready = select(listenSocket + 1, &readSet, nullptr, nullptr, &timeout);
#endif

      if (!running.load()) break;
      if (ready <= 0) continue;

      SocketHandle client = accept(listenSocket, nullptr, nullptr);
      if (client == kInvalidSocket) {
        continue;
      }

      HttpRequest request;
      if (!parseHttpRequest(client, request)) {
        closeSocket(client);
        continue;
      }

      const HttpResponse response = routeRequest(request);
      const std::string payload = buildHttpResponse(response);
#ifdef _WIN32
      send(client, payload.c_str(), static_cast<int>(payload.size()), 0);
#else
      send(client, payload.c_str(), payload.size(), 0);
#endif
      closeSocket(client);
    }

    closeSocket(listenSocket);
    listenSocket = kInvalidSocket;

#ifdef _WIN32
    WSACleanup();
#endif
  }
};

std::unique_ptr<AdapterServer> gServer;

void recordEvent(PlayerButton button, bool down, bool player2) {
  if (!gRecordActive.load() || gReplayActive.load() || !gInLevel) return;
  MacroEvent event;
  event.t_ms = std::max(0.0, gGameTimeMs - gRecordStartMs);
  event.button = button;
  event.down = down;
  event.player2 = player2;
  gRecordingEvents.push_back(event);
}

void startRecordingIfArmed(bool replayInput, PlayerButton button, bool down, bool player2) {
  if (gRecordActive.load() || !gInLevel) return;
  if (gActivePlayLayer && gActivePlayLayer->m_isPaused) return;
  if (gActivePlayLayer && gActivePlayLayer->m_hasCompletedLevel) {
    gTakeoverArmed.store(false);
    gRecordArmed.store(false);
    return;
  }
  const bool takeoverArmed = gTakeoverArmed.load();
  const bool recordArmed = gRecordArmed.load();
  if (!takeoverArmed && !recordArmed) return;

  if (takeoverArmed) {
    // Takeover is valid only while replay is actively running.
    // If replay already ended (death/reset/stop), disarm takeover to avoid
    // accidental auto-recording on the next manual input.
    if (!gReplayActive.load()) {
      gTakeoverArmed.store(false);
      return;
    }
    if (replayInput) return;
    double takeoverStartMs = std::max(0.0, gGameTimeMs - gReplayStartMs);
    if (!gReplayEvents.empty()) {
      const double maxReplayMs = std::max(0.0, gReplayEvents.back().t_ms);
      takeoverStartMs = std::clamp(takeoverStartMs, 0.0, maxReplayMs);
    }
    stopReplay();
    startRecording();
    gRecordFromTakeover = true;
    gTakeoverStartMs = takeoverStartMs;
    // The takeover trigger edge must be part of segment B. Pre-seed the
    // per-button state so the current edge is emitted by updateButtonState.
    const int p = player2 ? 1 : 0;
    const int b = buttonIndex(button);
    gButtonDown[p][b] = !down;
    return;
  }
}

void dispatchReplayEvent(const MacroEvent& event) {
  if (!gActivePlayLayer) return;
  PlayerObject* player = event.player2 ? gActivePlayLayer->m_player2 : gActivePlayLayer->m_player1;
  if (!player) return;
  gReplayDispatching.store(true);
  if (event.down) {
    player->pushButton(event.button);
  } else {
    player->releaseButton(event.button);
  }
  gReplayDispatching.store(false);
}

void startRecording() {
  gRecordArmed.store(false);
  gTakeoverArmed.store(false);
  gRecordFromTakeover = false;
  gTakeoverStartMs = 0.0;
  gButtonDown[0][0] = gButtonDown[0][1] = gButtonDown[0][2] = false;
  gButtonDown[1][0] = gButtonDown[1][1] = gButtonDown[1][2] = false;
  std::lock_guard<std::mutex> lock(gMacroMutex);
  gRecordingEvents.clear();
  gRecordStartMs = gGameTimeMs;
  gRecordActive.store(true);
  gRecordComplete.store(false);
}

void stopRecording() {
  MacroData snapshot;
  {
    std::lock_guard<std::mutex> lock(gMacroMutex);
    snapshot.events = gRecordingEvents;
    snapshot.duration_ms = std::max(0.0, gGameTimeMs - gRecordStartMs);
    snapshot.start_ms = gRecordFromTakeover ? gTakeoverStartMs : gRecordStartMs;
    gLastMacro = snapshot;
    gRecordingEvents.clear();
  }
  gRecordActive.store(false);
  gRecordComplete.store(true);
  gRecordFromTakeover = false;
  gTakeoverStartMs = 0.0;
}

void startReplay() {
  std::lock_guard<std::mutex> lock(gMacroMutex);
  gReplayEvents = gPendingReplayEvents;
  gReplayIndex = 0;
  gReplayStartMs = gGameTimeMs;
  // Replay arm is one-shot: it should be consumed when replay actually begins.
  gReplayArmed.store(false);
  gReplayActive.store(!gReplayEvents.empty());
}

void stopReplay() {
  gReplayActive.store(false);
  gReplayArmed.store(false);
  gReplayRequested.store(false);
  gTakeoverArmed.store(false);
  gRecordArmed.store(false);
}

void startArmedActionsAtAttemptBoundary() {
  // Duplicate boundary callbacks can happen for a single respawn/reset.
  // Never reinitialize timing while replay/record is already running.
  if (gReplayActive.load() || gRecordActive.load()) {
    return;
  }

  const auto now = std::chrono::steady_clock::now();
  if (gLastAttemptBoundaryAt != std::chrono::steady_clock::time_point::min()) {
    const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(now - gLastAttemptBoundaryAt).count();
    if (elapsedMs >= 0 && elapsedMs < 120) {
      return;
    }
  }
  gLastAttemptBoundaryAt = now;

  gGameTimeMs = 0.0;
  gRecordStartMs = 0.0;
  gReplayStartMs = 0.0;
  gReplayIndex = 0;

  gButtonDown[0][0] = gButtonDown[0][1] = gButtonDown[0][2] = false;
  gButtonDown[1][0] = gButtonDown[1][1] = gButtonDown[1][2] = false;

  if (gReplayArmed.load()) {
    startReplay();
  }
  if (gRecordArmed.load() && !gReplayActive.load()) {
    startRecording();
  }
}

bool didAnyPlayerDie() {
  if (!gActivePlayLayer) return false;
  auto* player1 = gActivePlayLayer->m_player1;
  auto* player2 = gActivePlayLayer->m_player2;
  const bool player1Dead = player1 && player1->m_isDead;
  const bool player2Dead = player2 && player2->m_isDead;
  return player1Dead || player2Dead;
}

class $modify(GJBaseGameLayer) {
  void update(float dt) {
    GJBaseGameLayer::update(dt);
    auto current = PlayLayer::get();
    const bool hadLevel = gActivePlayLayer != nullptr;
    const bool levelChanged = current != gActivePlayLayer;
    if (levelChanged) {
      // If the level context changes while actively recording, finalize first
      // so /record/stop can still return a consistent snapshot.
      if (gRecordActive.load()) {
        stopRecording();
      }
      gActivePlayLayer = current;
      gGameTimeMs = 0.0;
      gRecordStartMs = 0.0;
      gReplayStartMs = 0.0;
      gReplayIndex = 0;
      gReplayActive.store(false);
      gTakeoverArmed.store(false);
      gRecordFromTakeover = false;
      gTakeoverStartMs = 0.0;
      if (hadLevel) {
        gRecordArmed.store(false);
      }
      gRecordStopRequested.store(false);
      gReplayRequested.store(false);
      gReplayStopRequested.store(false);
      gAttemptBoundaryPending = false;
      gWasPaused = false;
      gPauseStartedGameMs = 0.0;
      gButtonDown[0][0] = gButtonDown[0][1] = gButtonDown[0][2] = false;
      gButtonDown[1][0] = gButtonDown[1][1] = gButtonDown[1][2] = false;
    }
    gInLevel = current != nullptr;
    if (!gInLevel) return;

    const bool levelStarted = levelChanged && current != nullptr;
    if (levelStarted) {
      gAttemptBoundaryPending = true;
    }

    const bool paused = current->m_isPaused;
    if (paused) {
      if (!gWasPaused) {
        gWasPaused = true;
        gPauseStartedGameMs = gGameTimeMs;
      }
    } else if (gWasPaused) {
      // Compensate any clock drift accumulated while paused so replay timing
      // resumes tightly on unpause.
      const double pausedDriftMs = std::max(0.0, gGameTimeMs - gPauseStartedGameMs);
      if (pausedDriftMs > 0.0) {
        if (gReplayActive.load()) {
          gReplayStartMs += pausedDriftMs;
        }
        if (gRecordActive.load()) {
          gRecordStartMs += pausedDriftMs;
        }
      }
      gWasPaused = false;
      gPauseStartedGameMs = 0.0;
    }

    const bool levelCompleted = current->m_hasCompletedLevel;
    if (gAttemptBoundaryPending && !paused && !levelCompleted && !didAnyPlayerDie()) {
      gAttemptBoundaryPending = false;
      startArmedActionsAtAttemptBoundary();
    }
    if (!paused) {
      gGameTimeMs += static_cast<double>(dt) * 1000.0;
    }

    if (gRecordStopRequested.exchange(false) && gRecordActive.load()) {
      stopRecording();
    }

    // Backward compatibility: older clients may still toggle replay via
    // replay_requested. Convert that into a deterministic replay arm.
    if (gReplayRequested.exchange(false)) {
      gReplayArmed.store(true);
    }
    if (gReplayStopRequested.exchange(false)) {
      stopReplay();
    }

    // Stop playback immediately on death. Without this, replay can continue
    // after respawn and cause desynced UI state.
    // Important: if replay is only armed (not yet active), keep it armed so
    // it can start on the next attempt boundary.
    if (didAnyPlayerDie()) {
      gReplayRequested.store(false);
      gReplayStopRequested.store(false);
      if (gReplayActive.load()) {
        stopReplay();
      }
      if (gRecordActive.load()) {
        stopRecording();
        // Active recording should not stay armed after finalize.
        gRecordArmed.store(false);
      }
      // Keep record_armed across death when recording is not yet active, so
      // F9 arm can start on the next attempt boundary.
      gTakeoverArmed.store(false);
    }

    if (levelCompleted) {
      gReplayRequested.store(false);
      gReplayStopRequested.store(false);
      stopReplay();
      if (gRecordActive.load()) {
        stopRecording();
      }
      gRecordArmed.store(false);
      gTakeoverArmed.store(false);
    }

    if (paused) {
      return;
    }

    if (gReplayActive.load()) {
      const double elapsed = gGameTimeMs - gReplayStartMs;
      while (gReplayIndex < gReplayEvents.size()) {
        const auto& event = gReplayEvents[gReplayIndex];
        if (event.t_ms > elapsed + kMsEpsilon) break;
        dispatchReplayEvent(event);
        gReplayIndex += 1;
      }
      if (gReplayIndex >= gReplayEvents.size()) {
        gReplayActive.store(false);
        gTakeoverArmed.store(false);
        gRecordArmed.store(false);
      }
    }
  }
};

class $modify(PlayLayer) {
  void resetLevel() {
    PlayLayer::resetLevel();
    gAttemptBoundaryPending = true;
    gWasPaused = false;
    gPauseStartedGameMs = 0.0;
  }

  void resetLevelFromStart() {
    PlayLayer::resetLevelFromStart();
    gAttemptBoundaryPending = true;
    gWasPaused = false;
    gPauseStartedGameMs = 0.0;
  }

  void onQuit() {
    PlayLayer::onQuit();
    stopReplay();
    if (gRecordActive.load()) {
      stopRecording();
    }
    gRecordArmed.store(false);
    gTakeoverArmed.store(false);
    gRecordStopRequested.store(false);
    gAttemptBoundaryPending = false;
    gWasPaused = false;
    gPauseStartedGameMs = 0.0;
  }
};

class $modify(PlayerObject) {
  bool pushButton(PlayerButton button) {
    const bool result = PlayerObject::pushButton(button);
    const bool player2 = gActivePlayLayer && this == gActivePlayLayer->m_player2;
    startRecordingIfArmed(gReplayDispatching.load(), button, true, player2);
    const bool changed = updateButtonState(button, true, player2);
    if (gRecordActive.load() && !gReplayActive.load() && gActivePlayLayer && changed) {
      recordEvent(button, true, player2);
    }
    return result;
  }

  bool releaseButton(PlayerButton button) {
    const bool result = PlayerObject::releaseButton(button);
    const bool player2 = gActivePlayLayer && this == gActivePlayLayer->m_player2;
    startRecordingIfArmed(gReplayDispatching.load(), button, false, player2);
    const bool changed = updateButtonState(button, false, player2);
    if (gRecordActive.load() && !gReplayActive.load() && gActivePlayLayer && changed) {
      recordEvent(button, false, player2);
    }
    return result;
  }
};
} // namespace

$on_mod(Loaded) {
  gServer = std::make_unique<AdapterServer>();
  gServer->start();
}
