// Dictation on iOS 26's SpeechAnalyzer + SpeechTranscriber: on the phone,
// long-form, and more accurate than the SFSpeechRecognizer model that
// expo-speech-recognition drives. The JS half (src/lib/speechAnalyzer.ts)
// uses it when `prepareAsync` says the locale's model is installed, and the
// old recognizer otherwise; it emits the same events, with the same payloads,
// as expo-speech-recognition (start, result, volumechange, audioend, error,
// end), so lib/dictation.ts can't tell them apart.

import AVFoundation
import Accelerate
import ExpoModulesCore
import Speech

struct AnalyzerStartOptions: Record {
  @Field var locale: String? = nil
  @Field var contextualStrings: [String] = []
  @Field var volumeIntervalMillis: Double = 50
  /// Keep the audio as a 16-bit WAV at this rate (a voice message's recording).
  @Field var recordSampleRate: Double? = nil
}

public class SpeechAnalyzerModule: Module {
  /// The live session (an `AnalyzerSession` on iOS 26+).
  private var session: AnyObject?
  /// A model download already asked for in this process, by locale.
  private var downloading = Set<String>()
  private let downloadingLock = NSLock()

  /// True when this call should ask for the download (not already asked for).
  private func claimDownload(_ key: String) -> Bool {
    downloadingLock.lock()
    defer { downloadingLock.unlock() }
    return downloading.insert(key).inserted
  }

  private func releaseDownload(_ key: String) {
    downloadingLock.lock()
    downloading.remove(key)
    downloadingLock.unlock()
  }

  public func definition() -> ModuleDefinition {
    Name("SpeechAnalyzer")

    Events("start", "result", "volumechange", "audioend", "error", "end")

    /// iOS 26+, and this device can run the transcriber at all.
    Function("isAvailable") { () -> Bool in
      if #available(iOS 26.0, *) {
        return SpeechTranscriber.isAvailable
      }
      return false
    }

    /// Whether the locale's model is here: "installed", "downloading" (asked
    /// for now, or already on its way), "unsupported" or "unavailable".
    AsyncFunction("prepareAsync") { (localeId: String?) async -> String in
      guard #available(iOS 26.0, *), SpeechTranscriber.isAvailable else { return "unavailable" }
      let wanted = localeId.map { Locale(identifier: $0) } ?? Locale.current
      guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
        return "unsupported"
      }
      let transcriber = AnalyzerSession.makeTranscriber(locale)
      switch await AssetInventory.status(forModules: [transcriber]) {
      case .installed:
        return "installed"
      case .downloading:
        return "downloading"
      case .supported:
        let key = locale.identifier
        if self.claimDownload(key) {
          Task.detached {
            do {
              if let request = try await AssetInventory.assetInstallationRequest(supporting: [
                transcriber
              ]) {
                try await request.downloadAndInstall()
              }
            } catch {
              // Asked again on the next prepare.
            }
            self.releaseDownload(key)
          }
        }
        return "downloading"
      case .unsupported:
        return "unsupported"
      @unknown default:
        return "unsupported"
      }
    }

    Function("start") { (options: AnalyzerStartOptions) in
      guard #available(iOS 26.0, *) else {
        self.sendEvent("error", ["error": "service-not-allowed", "message": "Needs iOS 26."])
        self.sendEvent("end")
        return
      }
      // One at a time: a session still on its way out is ended for good.
      (self.session as? AnalyzerSession)?.abort()
      let session = AnalyzerSession(options: options) { [weak self] name, body in
        self?.sendEvent(name, body)
      }
      self.session = session
      session.start()
    }

    Function("stop") {
      if #available(iOS 26.0, *) {
        (self.session as? AnalyzerSession)?.stop()
      }
    }

    Function("abort") {
      if #available(iOS 26.0, *) {
        (self.session as? AnalyzerSession)?.abort()
      }
    }
  }
}

@available(iOS 26.0, *)
final class AnalyzerSession {
  typealias Emit = (String, [String: Any?]) -> Void

  private let options: AnalyzerStartOptions
  private let emit: Emit
  private let lock = NSLock()

  private var engine: AVAudioEngine?
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var resultsTask: Task<Void, Never>?
  private var file: AVAudioFile?
  private var fileURL: URL?
  private var observers: [NSObjectProtocol] = []

  // Guarded by `lock`.
  private var stopping = false
  private var aborted = false
  private var ended = false

  init(options: AnalyzerStartOptions, emit: @escaping Emit) {
    self.options = options
    self.emit = emit
  }

  static func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
    // Volatile results stream the words as they're decided; the finals are
    // the model's best, with its own punctuation and capitals. Fast results
    // send them as soon as they're heard rather than in chunks a few seconds
    // apart (the computer's pass gets the words right after).
    SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults, .fastResults],
      attributeOptions: []
    )
  }

  private func flag(_ read: (AnalyzerSession) -> Bool) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return read(self)
  }

  func start() {
    Task { await self.run() }
  }

  private func run() async {
    let wanted = options.locale.map { Locale(identifier: $0) } ?? Locale.current
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
      return fail("language-not-supported", "This language isn't supported.")
    }
    let transcriber = Self.makeTranscriber(locale)
    guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
      return fail("language-not-supported", "The speech model isn't on this phone yet.")
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    else {
      return fail("audio-capture", "No audio format for the transcriber.")
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    self.analyzer = analyzer
    do {
      try await analyzer.prepareToAnalyze(in: format)
    } catch {
      return fail("audio-capture", error.localizedDescription)
    }
    // The team's names. Best effort: a transcriber that ignores context still works.
    let strings = options.contextualStrings.filter { !$0.isEmpty }
    if !strings.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings[.general] = Array(strings.prefix(100))
      try? await analyzer.setContext(context)
    }
    if flag({ $0.aborted || $0.stopping }) { return finish() }

    // Results: volatile ones replace the words being decided, a final one
    // keeps that stretch (expo-speech-recognition's `result` shape).
    resultsTask = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          guard let self else { return }
          if self.flag({ $0.aborted }) { return }
          let text = String(result.text.characters)
          self.emit(
            "result",
            [
              "isFinal": result.isFinal,
              "results": [["transcript": text, "confidence": 0, "segments": []]],
            ])
        }
      } catch {
        guard let self, !self.flag({ $0.aborted }) else { return }
        self.emit("error", ["error": "audio-capture", "message": error.localizedDescription])
      }
    }

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    input = continuation
    do {
      try await analyzer.start(inputSequence: stream)
    } catch {
      return fail("audio-capture", error.localizedDescription)
    }

    do {
      try Self.setUpAudioSession()
      try startEngine(analyzerFormat: format)
    } catch let e as SessionError {
      return fail(e.code, e.message)
    } catch {
      return fail("audio-capture", error.localizedDescription)
    }
    if flag({ $0.aborted || $0.stopping }) {
      // Asked to stop while setting up: nothing heard, end now.
      stopAudio()
      input?.finish()
      await analyzer.cancelAndFinishNow()
      return finish()
    }
    observe()
    emit("start", [:])
  }

  // MARK: Audio

  struct SessionError: Error {
    let code: String
    let message: String
  }

  /// expo-speech-recognition's default, so the two leave the session alike.
  private static func setUpAudioSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
    try session.setActive(true, options: .notifyOthersOnDeactivation)
  }

  private func startEngine(analyzerFormat: AVAudioFormat) throws {
    let engine = AVAudioEngine()
    let node = engine.inputNode
    let micFormat = node.outputFormat(forBus: 0)
    guard micFormat.sampleRate > 0, micFormat.channelCount > 0 else {
      throw SessionError(code: "audio-capture", message: "The microphone is busy.")
    }
    guard let toAnalyzer = AVAudioConverter(from: micFormat, to: analyzerFormat) else {
      throw SessionError(code: "audio-capture", message: "Can't convert the microphone's audio.")
    }

    var toFile: AVAudioConverter?
    var fileFormat: AVAudioFormat?
    if let rate = options.recordSampleRate, rate > 0,
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: micFormat, to: format),
      let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    {
      let url = dir.appendingPathComponent("recording_\(UUID().uuidString).wav")
      if let file = try? AVAudioFile(
        forWriting: url, settings: format.settings, commonFormat: .pcmFormatInt16,
        interleaved: true)
      {
        self.file = file
        self.fileURL = url
        toFile = converter
        fileFormat = format
      }
    }

    // The level, as expo-speech-recognition reports it: the window's peak,
    // -60..0 dB scaled onto -2..10, every `volumeIntervalMillis`.
    let windowFrames = max(
      1, AVAudioFrameCount(micFormat.sampleRate * options.volumeIntervalMillis / 1000))
    var framesSinceLevel: AVAudioFrameCount = 0
    var peak: Float = 0

    node.installTap(onBus: 0, bufferSize: 1024, format: micFormat) { [weak self] buffer, _ in
      guard let self else { return }
      if let converted = Self.convert(buffer, with: toAnalyzer, to: analyzerFormat) {
        self.input?.yield(AnalyzerInput(buffer: converted))
      }
      if let toFile, let fileFormat, let file = self.file,
        let converted = Self.convert(buffer, with: toFile, to: fileFormat)
      {
        try? file.write(from: converted)
      }
      peak = max(peak, Self.peak(buffer))
      framesSinceLevel += buffer.frameLength
      if framesSinceLevel >= windowFrames {
        let db = 20 * log10(max(peak, 1e-7))
        let normalized = min(max((db + 60) / 60, 0), 1)
        self.emit("volumechange", ["value": normalized * 12 - 2])
        framesSinceLevel = 0
        peak = 0
      }
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      node.removeTap(onBus: 0)
      throw SessionError(code: "audio-capture", message: error.localizedDescription)
    }
    self.engine = engine
  }

  private static func convert(
    _ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat
  ) -> AVAudioPCMBuffer? {
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var given = false
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { _, inputStatus in
      if given {
        inputStatus.pointee = .noDataNow
        return nil
      }
      given = true
      inputStatus.pointee = .haveData
      return buffer
    }
    guard status != .error, error == nil, out.frameLength > 0 else { return nil }
    return out
  }

  private static func peak(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
    var value: Float = 0
    vDSP_maxmgv(data[0], buffer.stride, &value, vDSP_Length(buffer.frameLength))
    return value
  }

  private func stopAudio() {
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
  }

  private func observe() {
    let center = NotificationCenter.default
    // A call or another app took the microphone: keep what was heard.
    observers.append(
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance(), queue: nil
      ) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        guard raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began else { return }
        self?.emit("error", ["error": "interrupted", "message": "The microphone was interrupted."])
        self?.stop()
      })
    // Headphones in or out stop the engine: finish with what was heard.
    if let engine {
      observers.append(
        center.addObserver(
          forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
          self?.stop()
        })
    }
  }

  // MARK: Ending

  /// Stop listening and keep what was heard: the last words still arrive, then `end`.
  func stop() {
    lock.lock()
    if stopping || aborted || ended {
      lock.unlock()
      return
    }
    stopping = true
    lock.unlock()
    guard engine != nil else { return }  // still setting up: `run` ends it
    stopAudio()
    input?.finish()
    Task {
      try? await self.analyzer?.finalizeAndFinishThroughEndOfInput()
      await self.resultsTask?.value
      self.finish()
    }
  }

  /// End at once: nothing more is reported but `end`.
  func abort() {
    lock.lock()
    if aborted || ended {
      lock.unlock()
      return
    }
    aborted = true
    lock.unlock()
    let wasRunning = engine != nil
    stopAudio()
    input?.finish()
    resultsTask?.cancel()
    if !wasRunning && analyzer == nil { return }  // still setting up: `run` ends it
    Task {
      await self.analyzer?.cancelAndFinishNow()
      self.finish()
    }
  }

  private func fail(_ code: String, _ message: String) {
    stopAudio()
    input?.finish()
    if !flag({ $0.aborted }) {
      emit("error", ["error": code, "message": message])
    }
    if let analyzer {
      Task {
        await analyzer.cancelAndFinishNow()
        self.finish()
      }
    } else {
      finish()
    }
  }

  private func finish() {
    lock.lock()
    if ended {
      lock.unlock()
      return
    }
    ended = true
    lock.unlock()
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
    // Closing the file: AVAudioFile writes its header when it's released.
    let uri = fileURL?.absoluteString
    file = nil
    fileURL = nil
    emit("audioend", ["uri": uri, "timestamp": Date().timeIntervalSince1970 * 1000])
    emit("end", [:])
  }
}
