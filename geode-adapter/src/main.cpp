#include <Geode/Geode.hpp>
#include <Geode/modify/GJBaseGameLayer.hpp>
#include <Geode/modify/PlayLayer.hpp>
#include <Geode/modify/PlayerObject.hpp>
#include <matjson.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
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
constexpr double kTickHz = 240.0;
constexpr double kTickMs = 1000.0 / kTickHz;
constexpr double kTakeoverPauseGuardMs = 700.0;

#ifdef _WIN32
using SocketHandle = SOCKET;
const SocketHandle kInvalidSocket = INVALID_SOCKET;
#else
using SocketHandle = int;
const SocketHandle kInvalidSocket = -1;
#endif

struct MacroEvent {
  double t_ms = 0.0;
  std::int64_t t_tick = 0;
  PlayerButton button = PlayerButton::Jump;
  bool down = false;
  bool player2 = false;
};

struct MacroData {
  std::vector<MacroEvent> events;
  double duration_ms = 0.0;
  double start_ms = 0.0;
};

struct ReplayDispatchSample {
  std::size_t event_index = 0;
  std::int64_t scheduled_tick = 0;
  std::int64_t actual_tick = 0;
  std::int64_t delta_tick = 0;
  double scheduled_ms = 0.0;
  double actual_ms = 0.0;
  double delta_ms = 0.0;
};

enum class ReplayState {
  Idle = 0,
  Armed = 1,
  Live = 2,
  Paused = 3,
};

enum class RecordState {
  Idle = 0,
  Armed = 1,
  Live = 2,
};

std::mutex gMacroMutex;
std::vector<MacroEvent> gRecordingEvents;
MacroData gLastMacro;
std::vector<MacroEvent> gPendingReplayEvents;
std::vector<MacroEvent> gReplayEvents;

std::atomic<ReplayState> gReplayState{ReplayState::Idle};
std::atomic<RecordState> gRecordState{RecordState::Idle};
std::atomic<std::uint64_t> gTransitionSeq{0};
std::mutex gTransitionMutex;
std::vector<matjson::Value> gTransitionLog;
constexpr std::size_t kTransitionLogLimit = 200;
std::mutex gReplayTelemetryMutex;
std::vector<ReplayDispatchSample> gReplayDispatchSamples;
constexpr std::size_t kReplayTelemetryLimit = 512;
std::atomic<std::uint64_t> gReplayRunId{0};

std::atomic<bool> gRecordArmed{false};
std::atomic<bool> gTakeoverArmed{false};
std::atomic<bool> gRecordActive{false};
std::atomic<bool> gRecordStopRequested{false};
std::atomic<bool> gRecordComplete{false};

std::atomic<bool> gReplayActive{false};
std::atomic<bool> gReplayStopRequested{false};
std::atomic<bool> gReplayArmed{false};
std::atomic<bool> gReplayDispatching{false};
std::atomic<bool> gReplaySessionActive{false};

PlayLayer* gActivePlayLayer = nullptr;
bool gInLevel = false;
bool gButtonDown[2][3] = {{false, false, false}, {false, false, false}};

// These are only accessed on the game thread.
double gGameTimeMs = 0.0;
double gGameRemainderMs = 0.0;
std::int64_t gGameTick = 0;
std::int64_t gRecordStartTick = 0;
std::int64_t gReplayStartTick = 0;
std::size_t gReplayIndex = 0;
bool gRecordFromTakeover = false;
std::int64_t gTakeoverStartTick = 0;
bool gAttemptBoundaryPending = false;
std::int64_t gAttemptSerial = 0;
std::int64_t gReplayStartBoundarySerial = 0;
bool gWasPaused = false;
double gPauseStartedGameMs = 0.0;
bool gIgnoreNextTakeoverInput = false;
double gTakeoverInputIgnoreUntilMs = 0.0;
bool gReplayWasActiveBeforePause = false;
bool gBlockTakeoverUntilReplayDispatch = false;
bool gSkipNextDtAfterUnpause = false;
std::int64_t gReplayPhaseTicks = 0;

void startRecording();
void stopReplay();
void startReplay();

std::uint64_t unixNowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

const char* replayStateToString(ReplayState value) {
  switch (value) {
    case ReplayState::Armed:
      return "armed";
    case ReplayState::Live:
      return "live";
    case ReplayState::Paused:
      return "paused";
    default:
      return "idle";
  }
}

const char* recordStateToString(RecordState value) {
  switch (value) {
    case RecordState::Armed:
      return "armed";
    case RecordState::Live:
      return "live";
    default:
      return "idle";
  }
}

void appendTransition(const char* domain, const char* from, const char* to, const char* reason) {
  auto entry = matjson::Value::object();
  entry["seq"] = static_cast<double>(gTransitionSeq.fetch_add(1) + 1);
  entry["ts_ms"] = static_cast<double>(unixNowMs());
  entry["game_ms"] = gGameTimeMs;
  entry["game_tick"] = static_cast<double>(gGameTick);
  entry["domain"] = domain;
  entry["from"] = from;
  entry["to"] = to;
  entry["reason"] = reason;
  entry["in_level"] = gInLevel;
  entry["paused"] = gActivePlayLayer && gActivePlayLayer->m_isPaused;

  std::lock_guard<std::mutex> lock(gTransitionMutex);
  gTransitionLog.push_back(entry);
  if (gTransitionLog.size() > kTransitionLogLimit) {
    const auto trim = gTransitionLog.size() - kTransitionLogLimit;
    gTransitionLog.erase(gTransitionLog.begin(), gTransitionLog.begin() + static_cast<std::ptrdiff_t>(trim));
  }
}

void setReplayState(ReplayState next, const char* reason) {
  const ReplayState prev = gReplayState.exchange(next);
  if (prev == next) return;
  appendTransition("replay_state", replayStateToString(prev), replayStateToString(next), reason);
}

void setRecordState(RecordState next, const char* reason) {
  const RecordState prev = gRecordState.exchange(next);
  if (prev == next) return;
  appendTransition("record_state", recordStateToString(prev), recordStateToString(next), reason);
}

double snapToTick(double ms) {
  if (ms <= 0.0) return 0.0;
  return std::round(ms / kTickMs) * kTickMs;
}

std::int64_t msToTick(double ms) {
  if (!std::isfinite(ms) || ms <= 0.0) return 0;
  return static_cast<std::int64_t>(std::llround(ms / kTickMs));
}

double tickToMs(std::int64_t tick) {
  if (tick <= 0) return 0.0;
  return static_cast<double>(tick) * kTickMs;
}

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
  payload["version"] = "0.2.5";
  payload["protocol_version"] = "1.0.0";
  payload["timing_domain"] = "tick";
  payload["boundary_policy"] = "attempt_boundary_only";
  payload["pause_policy"] = "freeze_no_dispatch";
  payload["takeover_policy"] = "replay_live_press_edge_only";
  auto caps = matjson::Value::array();
  caps.push("status");
  caps.push("record");
  caps.push("replay");
  payload["capabilities"] = caps;
  payload["tick_hz"] = 240;
  payload["game_tick"] = static_cast<double>(gGameTick);
  payload["replay_index"] = static_cast<double>(gReplayIndex);
  payload["attempt_serial"] = static_cast<double>(gAttemptSerial);
  payload["replay_run_id"] = static_cast<double>(gReplayRunId.load());
  payload["replay_phase_ticks"] = static_cast<double>(gReplayPhaseTicks);
  payload["record_active"] = gRecordActive.load();
  payload["record_armed"] = gRecordArmed.load();
  payload["record_complete"] = gRecordComplete.load();
  payload["record_state"] = recordStateToString(gRecordState.load());
  payload["replay_active"] = gReplayActive.load();
  payload["replay_armed"] = gReplayArmed.load();
  payload["replay_requested"] = gReplaySessionActive.load();
  payload["replay_state"] = replayStateToString(gReplayState.load());
  payload["paused"] = gActivePlayLayer && gActivePlayLayer->m_isPaused;
  payload["takeover_armed"] = gTakeoverArmed.load();
  return payload.dump(matjson::NO_INDENTATION);
}

std::string buildTransitionsPayload() {
  auto payload = matjson::Value::object();
  payload["ok"] = true;
  auto transitions = matjson::Value::array();
  {
    std::lock_guard<std::mutex> lock(gTransitionMutex);
    for (const auto& entry : gTransitionLog) {
      transitions.push(entry);
    }
  }
  payload["transitions"] = transitions;
  return payload.dump(matjson::NO_INDENTATION);
}

void clearReplayTelemetry() {
  std::lock_guard<std::mutex> lock(gReplayTelemetryMutex);
  gReplayDispatchSamples.clear();
}

void appendReplayDispatchSample(std::size_t eventIndex, const MacroEvent& event, std::int64_t actualTick) {
  ReplayDispatchSample sample;
  sample.event_index = eventIndex;
  sample.scheduled_tick = event.t_tick;
  sample.actual_tick = actualTick;
  sample.delta_tick = actualTick - event.t_tick;
  sample.scheduled_ms = tickToMs(event.t_tick);
  sample.actual_ms = tickToMs(actualTick);
  sample.delta_ms = sample.actual_ms - sample.scheduled_ms;

  std::lock_guard<std::mutex> lock(gReplayTelemetryMutex);
  if (gReplayDispatchSamples.size() >= kReplayTelemetryLimit) {
    gReplayDispatchSamples.erase(gReplayDispatchSamples.begin());
  }
  gReplayDispatchSamples.push_back(sample);
}

std::string buildReplayTelemetryPayload() {
  auto payload = matjson::Value::object();
  payload["ok"] = true;
  payload["run_id"] = static_cast<double>(gReplayRunId.load());
  payload["replay_phase_ticks"] = static_cast<double>(gReplayPhaseTicks);
  payload["attempt_serial"] = static_cast<double>(gAttemptSerial);
  auto samples = matjson::Value::array();
  {
    std::lock_guard<std::mutex> lock(gReplayTelemetryMutex);
    for (const auto& sample : gReplayDispatchSamples) {
      auto entry = matjson::Value::object();
      entry["event_index"] = static_cast<double>(sample.event_index);
      entry["scheduled_tick"] = static_cast<double>(sample.scheduled_tick);
      entry["actual_tick"] = static_cast<double>(sample.actual_tick);
      entry["delta_tick"] = static_cast<double>(sample.delta_tick);
      entry["scheduled_ms"] = sample.scheduled_ms;
      entry["actual_ms"] = sample.actual_ms;
      entry["delta_ms"] = sample.delta_ms;
      samples.push(entry);
    }
  }
  payload["samples"] = samples;
  payload["count"] = static_cast<double>(samples.size());
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
    event.t_ms = snapToTick(event.t_ms);
    event.t_tick = msToTick(event.t_ms);
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
    if (a.t_tick != b.t_tick) return a.t_tick < b.t_tick;
    if (a.t_ms != b.t_ms) return a.t_ms < b.t_ms;
    return a.down && !b.down;
  });

  return true;
}

HttpResponse handleRecordStart() {
  if (gRecordActive.load()) {
    setRecordState(RecordState::Live, "record_start_while_live");
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
  gTakeoverStartTick = 0;
  setRecordState(RecordState::Armed, "record_start_armed");
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
    gTakeoverStartTick = 0;
    MacroData snapshot;
    {
      std::lock_guard<std::mutex> lock(gMacroMutex);
      gRecordingEvents.clear();
      gLastMacro = snapshot;
    }
    setRecordState(RecordState::Idle, "record_stop_disarmed_without_live");
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
    snapshot.duration_ms = tickToMs(std::max<std::int64_t>(0, gGameTick - gRecordStartTick));
    snapshot.start_ms = gRecordFromTakeover ? tickToMs(gTakeoverStartTick) : tickToMs(gRecordStartTick);
    gLastMacro = snapshot;
    gRecordingEvents.clear();
    gRecordActive.store(false);
    gRecordArmed.store(false);
    gTakeoverArmed.store(false);
    gRecordComplete.store(false);
    gRecordFromTakeover = false;
    gTakeoverStartTick = 0;
    setRecordState(RecordState::Idle, "record_stop_timeout_finalize");
  } else {
    std::lock_guard<std::mutex> lock(gMacroMutex);
    snapshot = gLastMacro;
    gRecordComplete.store(false);
    setRecordState(RecordState::Idle, "record_stop_complete_finalize");
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
  // Replay start must clear standalone recording arm state so pause/resume
  // interactions cannot switch into recording via stale F9 arm.
  gRecordArmed.store(false);
  gRecordStopRequested.store(false);
  gRecordComplete.store(false);

  {
    std::lock_guard<std::mutex> lock(gMacroMutex);
    gPendingReplayEvents = std::move(events);
  }
  gReplayStopRequested.store(false);
  gReplayArmed.store(true);
  gReplayStartBoundarySerial = gAttemptSerial + (gAttemptBoundaryPending ? 0 : 1);
  clearReplayTelemetry();
  setReplayState(ReplayState::Armed, "replay_start_armed");

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
    std::int64_t takeoverStartTick =
      gReplayActive.load() ? std::max<std::int64_t>(0, gGameTick - gReplayStartTick) : std::max<std::int64_t>(0, gGameTick);
    if (!gReplayEvents.empty()) {
      const auto maxReplayTick = std::max<std::int64_t>(0, gReplayEvents.back().t_tick);
      takeoverStartTick = std::clamp(takeoverStartTick, static_cast<std::int64_t>(0), maxReplayTick);
    }
    gReplayStopRequested.store(false);
    stopReplay();
    startRecording();
    gRecordFromTakeover = true;
    gTakeoverStartTick = takeoverStartTick;
    auto payload = matjson::Value::object();
    payload["ok"] = true;
    payload["state"] = "recording";
    payload["immediate"] = true;
    return {200, payload.dump(matjson::NO_INDENTATION)};
  }

  if (!gReplayActive.load() && !gReplayArmed.load()) {
    return {400, buildErrorPayload("not_replaying")};
  }

  gTakeoverArmed.store(true);
  gRecordArmed.store(false);
  gRecordStopRequested.store(false);
  gRecordComplete.store(false);
  gRecordStartTick = gGameTick;
  auto payload = matjson::Value::object();
  payload["ok"] = true;
  payload["state"] = "takeover_armed";
  return {200, payload.dump(matjson::NO_INDENTATION)};
}

HttpResponse handleReplayStop() {
  gReplayArmed.store(false);
  gReplayStopRequested.store(true);
  if (!gReplayActive.load() && !gReplaySessionActive.load()) {
    setReplayState(ReplayState::Idle, "replay_stop_when_not_live");
  }
  auto payload = matjson::Value::object();
  payload["ok"] = true;
  payload["state"] = "stopped";
  return {200, payload.dump(matjson::NO_INDENTATION)};
}

HttpResponse routeRequest(const HttpRequest& request) {
  if (request.method == "GET" && request.path == "/status") {
    return {200, buildStatusPayload()};
  }
  if (request.method == "GET" && request.path == "/debug/transitions") {
    return {200, buildTransitionsPayload()};
  }
  if (request.method == "GET" && request.path == "/debug/replay-telemetry") {
    return {200, buildReplayTelemetryPayload()};
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
  event.t_tick = std::max<std::int64_t>(0, gGameTick - gRecordStartTick);
  event.t_ms = tickToMs(event.t_tick);
  event.button = button;
  event.down = down;
  event.player2 = player2;
  gRecordingEvents.push_back(event);
}

void startRecordingIfArmed(bool replayInput, PlayerButton button, bool down, bool player2) {
  if (gRecordActive.load() || !gInLevel) return;
  if (gActivePlayLayer && gActivePlayLayer->m_isPaused) {
    // Pause/menu input paths must never preserve takeover arm state.
    if (gTakeoverArmed.load()) {
      gTakeoverArmed.store(false);
    }
    gIgnoreNextTakeoverInput = true;
    gTakeoverInputIgnoreUntilMs =
      std::max(gTakeoverInputIgnoreUntilMs, gGameTimeMs + kTakeoverPauseGuardMs);
    return;
  }
  if (gActivePlayLayer && gActivePlayLayer->m_hasCompletedLevel) {
    gTakeoverArmed.store(false);
    gRecordArmed.store(false);
    return;
  }
  const bool takeoverArmed = gTakeoverArmed.load();
  const bool recordArmed = gRecordArmed.load();
  if (!takeoverArmed && !recordArmed) return;

  // Replay/takeover path owns input while replay is active/armed. Never allow
  // stale standalone record-arm to start recording in replay context.
  if (recordArmed && (gReplayActive.load() || gReplayArmed.load() || takeoverArmed)) {
    return;
  }

  if (takeoverArmed) {
    // Takeover is valid only while replay is actively running.
    // If replay already ended (death/reset/stop), disarm takeover to avoid
    // accidental auto-recording on the next manual input.
    if (!gReplayActive.load()) {
      gTakeoverArmed.store(false);
      return;
    }
    // Takeover must be an intentional press edge; never trigger on release.
    if (!down) {
      return;
    }
    if (!replayInput && gGameTimeMs <= gTakeoverInputIgnoreUntilMs) {
      return;
    }
    if (gIgnoreNextTakeoverInput && !replayInput) {
      gIgnoreNextTakeoverInput = false;
      return;
    }
    if (!replayInput && gBlockTakeoverUntilReplayDispatch) {
      return;
    }
    if (replayInput) return;
    std::int64_t takeoverStartTick = std::max<std::int64_t>(0, gGameTick - gReplayStartTick);
    if (!gReplayEvents.empty()) {
      const auto maxReplayTick = std::max<std::int64_t>(0, gReplayEvents.back().t_tick);
      takeoverStartTick = std::clamp(takeoverStartTick, static_cast<std::int64_t>(0), maxReplayTick);
    }
    stopReplay();
    startRecording();
    gRecordFromTakeover = true;
    gTakeoverStartTick = takeoverStartTick;
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
  gTakeoverStartTick = 0;
  gIgnoreNextTakeoverInput = false;
  gTakeoverInputIgnoreUntilMs = 0.0;
  gButtonDown[0][0] = gButtonDown[0][1] = gButtonDown[0][2] = false;
  gButtonDown[1][0] = gButtonDown[1][1] = gButtonDown[1][2] = false;
  std::lock_guard<std::mutex> lock(gMacroMutex);
  gRecordingEvents.clear();
  gRecordStartTick = gGameTick;
  gRecordActive.store(true);
  gRecordComplete.store(false);
  setRecordState(RecordState::Live, "record_start_live");
}

void stopRecording() {
  MacroData snapshot;
  {
    std::lock_guard<std::mutex> lock(gMacroMutex);
    snapshot.events = gRecordingEvents;
    snapshot.duration_ms = tickToMs(std::max<std::int64_t>(0, gGameTick - gRecordStartTick));
    snapshot.start_ms = gRecordFromTakeover ? tickToMs(gTakeoverStartTick) : tickToMs(gRecordStartTick);
    gLastMacro = snapshot;
    gRecordingEvents.clear();
  }
  gRecordActive.store(false);
  gRecordComplete.store(true);
  gRecordFromTakeover = false;
  gTakeoverStartTick = 0;
  setRecordState(RecordState::Idle, "record_live_stopped");
}

void startReplay() {
  std::lock_guard<std::mutex> lock(gMacroMutex);
  gReplayEvents = gPendingReplayEvents;
  for (auto& event : gReplayEvents) {
    event.t_ms = snapToTick(std::max(0.0, event.t_ms));
    event.t_tick = msToTick(event.t_ms);
  }
  std::sort(gReplayEvents.begin(), gReplayEvents.end(), [](const MacroEvent& a, const MacroEvent& b) {
    if (a.t_tick != b.t_tick) return a.t_tick < b.t_tick;
    if (a.t_ms != b.t_ms) return a.t_ms < b.t_ms;
    return a.down && !b.down;
  });
  gReplayRunId.fetch_add(1);
  clearReplayTelemetry();
  gReplayIndex = 0;
  gReplayStartTick = gGameTick + gReplayPhaseTicks;
  gIgnoreNextTakeoverInput = false;
  gBlockTakeoverUntilReplayDispatch = false;
  gReplayWasActiveBeforePause = false;
  // Replay arm is one-shot: it should be consumed when replay actually begins.
  gReplayArmed.store(false);
  const bool hasEvents = !gReplayEvents.empty();
  gReplayActive.store(hasEvents);
  gReplaySessionActive.store(hasEvents);
  setReplayState(hasEvents ? ReplayState::Live : ReplayState::Idle, "replay_start_live");

  // Phase-lock: dispatch all t_tick <= 0 events immediately at start so run
  // alignment does not depend on the first post-boundary update frame.
  const std::int64_t startElapsedTicks = std::max<std::int64_t>(0, gGameTick - gReplayStartTick);
  while (hasEvents && gReplayIndex < gReplayEvents.size()) {
    const auto& event = gReplayEvents[gReplayIndex];
    if (event.t_tick > startElapsedTicks) break;
    dispatchReplayEvent(event);
    appendReplayDispatchSample(gReplayIndex, event, startElapsedTicks);
    gBlockTakeoverUntilReplayDispatch = false;
    gReplayIndex += 1;
  }
  if (hasEvents && gReplayIndex >= gReplayEvents.size()) {
    gReplayActive.store(false);
    gReplaySessionActive.store(false);
    gTakeoverArmed.store(false);
    gRecordArmed.store(false);
    setReplayState(ReplayState::Idle, "replay_complete_immediate");
  }
}

void stopReplay() {
  gReplayActive.store(false);
  gReplaySessionActive.store(false);
  gReplayArmed.store(false);
  gTakeoverArmed.store(false);
  gRecordArmed.store(false);
  gIgnoreNextTakeoverInput = false;
  gTakeoverInputIgnoreUntilMs = 0.0;
  gReplayWasActiveBeforePause = false;
  gBlockTakeoverUntilReplayDispatch = false;
  setReplayState(ReplayState::Idle, "replay_stopped");
}

void startArmedActionsAtAttemptBoundary() {
  // Duplicate boundary callbacks can happen for a single respawn/reset.
  // Never reinitialize timing while replay/record is already running.
  if (gReplayActive.load() || gRecordActive.load()) {
    return;
  }

  gGameTimeMs = 0.0;
  gGameRemainderMs = 0.0;
  gGameTick = 0;
  gRecordStartTick = 0;
  gReplayStartTick = 0;
  gReplayIndex = 0;
  gIgnoreNextTakeoverInput = false;
  gTakeoverInputIgnoreUntilMs = 0.0;
  gBlockTakeoverUntilReplayDispatch = false;

  gButtonDown[0][0] = gButtonDown[0][1] = gButtonDown[0][2] = false;
  gButtonDown[1][0] = gButtonDown[1][1] = gButtonDown[1][2] = false;

  if (gReplayArmed.load()) {
    // Strict replay boundary latch: a replay armed during an active attempt
    // must only start on the next attempt boundary.
    if (gAttemptSerial >= gReplayStartBoundarySerial) {
      startReplay();
    }
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
    // On some builds, opening the pause/menu UI can temporarily make
    // PlayLayer::get() null even though the attempt is still alive. Keep the
    // in-level replay state intact and wait for PlayLayer to come back.
    if (!current && hadLevel &&
        (gReplayActive.load() || gReplaySessionActive.load() || gReplayArmed.load() || gTakeoverArmed.load() ||
         gRecordArmed.load())) {
      // Some pause/menu transitions temporarily null PlayLayer. Treat this as
      // a paused state so resume-click cannot be misinterpreted as takeover.
      if (!gWasPaused) {
        gWasPaused = true;
        gPauseStartedGameMs = gGameTimeMs;
        gReplayWasActiveBeforePause = gReplayActive.load() || gReplaySessionActive.load();
      }
      gIgnoreNextTakeoverInput = true;
      gTakeoverInputIgnoreUntilMs =
        std::max(gTakeoverInputIgnoreUntilMs, gGameTimeMs + kTakeoverPauseGuardMs);
      if (gReplaySessionActive.load() || gReplayActive.load()) {
        gBlockTakeoverUntilReplayDispatch = true;
      }
      if (gReplaySessionActive.load() || gReplayActive.load()) {
        setReplayState(ReplayState::Paused, "playlayer_null_paused");
      }
      if (gTakeoverArmed.load()) {
        // Pause/menu overlays can transiently null PlayLayer and bypass the
        // regular paused branch below. Disarm takeover here too so resume UI
        // clicks cannot be interpreted as takeover triggers.
        gTakeoverArmed.store(false);
      }
      return;
    }
    const bool levelChanged = current != gActivePlayLayer;
    if (levelChanged) {
      const bool previousLayerPaused = hadLevel && gActivePlayLayer && gActivePlayLayer->m_isPaused;
      const bool preservePausedSession =
        hadLevel && current &&
        (current->m_isPaused || previousLayerPaused) &&
        (gReplayActive.load() || gReplaySessionActive.load() || gReplayArmed.load() || gTakeoverArmed.load() ||
         gRecordActive.load() || gRecordArmed.load());
      if (preservePausedSession) {
        // Some pause/menu transitions swap the PlayLayer pointer while the
        // same attempt is still paused. Keep replay/record session state.
        gActivePlayLayer = current;
      } else {
      // If the level context changes while actively recording, finalize first
      // so /record/stop can still return a consistent snapshot.
        if (gRecordActive.load()) {
          stopRecording();
        }
        gActivePlayLayer = current;
        gGameTimeMs = 0.0;
        gGameRemainderMs = 0.0;
        gGameTick = 0;
        gRecordStartTick = 0;
        gReplayStartTick = 0;
        gReplayIndex = 0;
        gReplayActive.store(false);
        gReplaySessionActive.store(false);
        gTakeoverArmed.store(false);
        gRecordFromTakeover = false;
        gTakeoverStartTick = 0;
        gIgnoreNextTakeoverInput = false;
        gTakeoverInputIgnoreUntilMs = 0.0;
        gBlockTakeoverUntilReplayDispatch = false;
        gSkipNextDtAfterUnpause = false;
        gReplayWasActiveBeforePause = false;
        if (hadLevel) {
          gRecordArmed.store(false);
        }
        gRecordStopRequested.store(false);
        gReplayStopRequested.store(false);
        gAttemptBoundaryPending = false;
        gWasPaused = false;
        gPauseStartedGameMs = 0.0;
        setReplayState(ReplayState::Idle, "level_context_changed");
        setRecordState(RecordState::Idle, "level_context_changed");
        gButtonDown[0][0] = gButtonDown[0][1] = gButtonDown[0][2] = false;
        gButtonDown[1][0] = gButtonDown[1][1] = gButtonDown[1][2] = false;
      }
    }
    gInLevel = current != nullptr;
    if (!gInLevel) return;

    const bool levelStarted = !hadLevel && current != nullptr;
    if (levelStarted) {
      gAttemptBoundaryPending = true;
      gAttemptSerial += 1;
    }

    const bool paused = current->m_isPaused;
    if (paused) {
      // Pause/menu UI clicks must never trigger takeover. Keep takeover
      // disarmed for the entire paused duration, not just first paused frame.
      if (gTakeoverArmed.load()) {
        gTakeoverArmed.store(false);
      }
      gIgnoreNextTakeoverInput = true;
      gTakeoverInputIgnoreUntilMs =
        std::max(gTakeoverInputIgnoreUntilMs, gGameTimeMs + kTakeoverPauseGuardMs);
      if (gReplaySessionActive.load() || gReplayActive.load()) {
        gBlockTakeoverUntilReplayDispatch = true;
      }

      if (!gWasPaused) {
        gWasPaused = true;
        gPauseStartedGameMs = gGameTimeMs;
        gReplayWasActiveBeforePause = gReplayActive.load() || gReplaySessionActive.load();
        if (gReplaySessionActive.load() || gReplayActive.load()) {
          setReplayState(ReplayState::Paused, "game_paused");
        }
      }
    } else if (gWasPaused) {
      // Tick-domain scheduler does not need start-time mutation on unpause.
      // Some pause/menu transitions can transiently drop replay active state.
      // If replay was active before pause and still has pending events, restore it.
      if (gReplayWasActiveBeforePause && !gReplayActive.load() && gReplayIndex < gReplayEvents.size()) {
        gReplayActive.store(true);
        gReplaySessionActive.store(true);
        gReplayStopRequested.store(false);
      }
      gReplayWasActiveBeforePause = false;
      gWasPaused = false;
      gPauseStartedGameMs = 0.0;
      // Guard the immediate post-unpause click path so the resume click cannot
      // be reinterpreted as takeover if controller re-arms quickly.
      gIgnoreNextTakeoverInput = true;
      gTakeoverInputIgnoreUntilMs =
        std::max(gTakeoverInputIgnoreUntilMs, gGameTimeMs + kTakeoverPauseGuardMs);
      gSkipNextDtAfterUnpause = true;
      if (gReplaySessionActive.load() || gReplayActive.load()) {
        gBlockTakeoverUntilReplayDispatch = true;
      }
      if (gReplaySessionActive.load() || gReplayActive.load()) {
        setReplayState(ReplayState::Live, "game_unpaused");
      } else if (gReplayArmed.load()) {
        setReplayState(ReplayState::Armed, "game_unpaused_keep_armed");
      } else {
        setReplayState(ReplayState::Idle, "game_unpaused_no_replay");
      }
    }

    const bool levelCompleted = current->m_hasCompletedLevel;
    if (gAttemptBoundaryPending && !paused && !levelCompleted && !didAnyPlayerDie()) {
      gAttemptBoundaryPending = false;
      startArmedActionsAtAttemptBoundary();
    }
    if (!paused) {
      double dtMs = static_cast<double>(dt) * 1000.0;
      if (gSkipNextDtAfterUnpause) {
        dtMs = 0.0;
        gSkipNextDtAfterUnpause = false;
      }
      gGameTimeMs += dtMs;
      gGameRemainderMs += dtMs;
      while (gGameRemainderMs + 1e-9 >= kTickMs) {
        gGameRemainderMs -= kTickMs;
        gGameTick += 1;
      }
    }

    // While paused, do not advance replay/record state via death/complete checks.
    // Only allow explicit stop requests.
    if (paused) {
      if (gReplaySessionActive.load() && !gReplayActive.load() && gReplayIndex < gReplayEvents.size() &&
          !gReplayStopRequested.load()) {
        gReplayActive.store(true);
      }
      if (gReplaySessionActive.load() || gReplayActive.load()) {
        setReplayState(ReplayState::Paused, "paused_loop");
      }
      if (gRecordStopRequested.exchange(false) && gRecordActive.load()) {
        stopRecording();
      }
      if (gReplayStopRequested.exchange(false)) {
        stopReplay();
      }
      return;
    }

    // If replay was armed/started and got dropped by a transient menu/pause
    // transition, recover replay on the same attempt.
    if (gReplaySessionActive.load() && !gReplayActive.load() && gReplayIndex < gReplayEvents.size() &&
        !gReplayStopRequested.load() && !didAnyPlayerDie() && !levelCompleted) {
      gReplayActive.store(true);
      setReplayState(ReplayState::Live, "replay_recovered_after_pause");
    }

    if (gRecordStopRequested.exchange(false) && gRecordActive.load()) {
      stopRecording();
    }

    if (gReplayStopRequested.exchange(false)) {
      stopReplay();
    }

    // Stop playback immediately on death. Without this, replay can continue
    // after respawn and cause desynced UI state.
    // Important: if replay is only armed (not yet active), keep it armed so
    // it can start on the next attempt boundary.
    if (didAnyPlayerDie()) {
      gReplayStopRequested.store(false);
      if (gReplayActive.load()) {
        stopReplay();
      }
      if (gRecordActive.load()) {
        stopRecording();
        // Active recording should not stay armed after finalize.
        gRecordArmed.store(false);
      }
      if (gRecordArmed.load()) {
        setRecordState(RecordState::Armed, "record_kept_armed_after_death");
      } else {
        setRecordState(RecordState::Idle, "record_idle_after_death");
      }
      // Keep record_armed across death when recording is not yet active, so
      // F9 arm can start on the next attempt boundary.
      gTakeoverArmed.store(false);
    }

    if (levelCompleted) {
      gReplayStopRequested.store(false);
      stopReplay();
      if (gRecordActive.load()) {
        stopRecording();
      }
      gRecordArmed.store(false);
      gTakeoverArmed.store(false);
      setRecordState(RecordState::Idle, "level_completed");
      setReplayState(ReplayState::Idle, "level_completed");
    }

    if (gReplayActive.load()) {
      const std::int64_t elapsedTicks = std::max<std::int64_t>(0, gGameTick - gReplayStartTick);
      while (gReplayIndex < gReplayEvents.size()) {
        const auto& event = gReplayEvents[gReplayIndex];
        if (event.t_tick > elapsedTicks) break;
        dispatchReplayEvent(event);
        appendReplayDispatchSample(gReplayIndex, event, elapsedTicks);
        gBlockTakeoverUntilReplayDispatch = false;
        gReplayIndex += 1;
      }
      if (gReplayIndex >= gReplayEvents.size()) {
        gReplayActive.store(false);
        gReplaySessionActive.store(false);
        gTakeoverArmed.store(false);
        gRecordArmed.store(false);
        setReplayState(ReplayState::Idle, "replay_complete");
      }
    }
  }
};

class $modify(PlayLayer) {
  void resetLevel() {
    PlayLayer::resetLevel();
    gAttemptBoundaryPending = true;
    gAttemptSerial += 1;
    gWasPaused = false;
    gPauseStartedGameMs = 0.0;
    gSkipNextDtAfterUnpause = false;
  }

  void resetLevelFromStart() {
    PlayLayer::resetLevelFromStart();
    gAttemptBoundaryPending = true;
    gAttemptSerial += 1;
    gWasPaused = false;
    gPauseStartedGameMs = 0.0;
    gSkipNextDtAfterUnpause = false;
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
    gBlockTakeoverUntilReplayDispatch = false;
    setReplayState(ReplayState::Idle, "playlayer_quit");
    setRecordState(RecordState::Idle, "playlayer_quit");
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
