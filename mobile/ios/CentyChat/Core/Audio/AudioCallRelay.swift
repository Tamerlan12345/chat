import AVFoundation
import Darwin
import Foundation
import QuartzCore

/// The PCM shape shared by the microphone encoder and the network relay.
public struct AudioRelayPCMFormat: Equatable, Sendable {
    public let sampleRate: Double
    public let channelCount: AVAudioChannelCount
    public let bitsPerChannel: Int

    public init(sampleRate: Double, channelCount: AVAudioChannelCount, bitsPerChannel: Int) {
        self.sampleRate = sampleRate
        self.channelCount = channelCount
        self.bitsPerChannel = bitsPerChannel
    }

    public static let voiceRelay = AudioRelayPCMFormat(
        sampleRate: AudioRelayEngine.sampleRate,
        channelCount: 1,
        bitsPerChannel: 16
    )
}

public enum AudioRecordPermission: Equatable, Sendable {
    case granted
    case denied
    case undetermined
}

public enum AudioRelayStartResult: Equatable, Sendable {
    case started
    case microphonePermissionDenied
    case unavailable
    case cancelled
}

public enum AudioRelayFailure: Equatable, Sendable {
    case unavailable
    case playbackUnavailable
}

public enum AudioRelayState: Equatable, Sendable {
    case inactive
    case starting
    case active
    case interrupted
    case failed(AudioRelayFailure)
}

public enum AudioRelayBackendEvent: Equatable, Sendable {
    case interruptionBegan
    case interruptionEnded(shouldResume: Bool)
    case routeChanged
}

/// Keeps only the most recent elements when a fixed-capacity queue is full.
struct BoundedNewestQueue<Element> {
    private var storage: [Element] = []

    let capacity: Int

    init(capacity: Int) {
        precondition(capacity > 0, "A bounded queue needs positive capacity")
        self.capacity = capacity
    }

    var count: Int { storage.count }
    var isEmpty: Bool { storage.isEmpty }
    var elements: [Element] { storage }

    mutating func append(_ element: Element) {
        if storage.count == capacity {
            storage.removeFirst()
        }
        storage.append(element)
    }

    mutating func popFirst() -> Element? {
        guard !storage.isEmpty else { return nil }
        return storage.removeFirst()
    }

    mutating func removeAll(keepingCapacity: Bool = true) {
        storage.removeAll(keepingCapacity: keepingCapacity)
    }
}

/// The narrow boundary that keeps relay logic testable without microphone hardware.
@MainActor
public protocol AudioRelayBackend: AnyObject {
    var recordPermission: AudioRecordPermission { get }
    var lifecycleHandler: ((AudioRelayBackendEvent) -> Void)? { get set }

    func requestRecordPermission() async -> Bool
    func startCapture(_ handler: @escaping ([Float]) -> Void) throws
    func stop()
    func pause()
    func reactivateAudioSession() throws
    func resume() throws
    func handleRouteChange() throws
    func resetPlayback()
    func schedulePlayback(samples: [Float], at time: TimeInterval) throws
}

/// Coordinates permission, PCM framing, playback scheduling, and AV lifecycle for one call.
@MainActor
public final class AudioCallRelay {
    public private(set) var state: AudioRelayState = .inactive {
        didSet { onStateChange?(state) }
    }
    public var onStateChange: ((AudioRelayState) -> Void)?
    public var onRecoveryRequired: ((AudioRelayFailure) -> Void)?

    public let targetUserId: Int64

    private let backend: any AudioRelayBackend
    private let sendFrame: (Data) -> Void
    private let now: () -> TimeInterval
    private let jitterScheduler = JitterScheduler()
    private var pendingSamples: [Float] = []
    private var incomingPlaybackFrames = BoundedNewestQueue<AudioRelayEngine.DecodedAudioFrame>(capacity: 8)
    private var isIncomingPlaybackPrimed = false
    private var isMuted = false
    private var startAttempt = 0

    private let minimumIncomingFramesBeforePlayback = 2

    public init(
        targetUserId: Int64,
        backend: any AudioRelayBackend,
        sendFrame: @escaping (Data) -> Void,
        now: @escaping () -> TimeInterval = CACurrentMediaTime
    ) {
        self.targetUserId = targetUserId
        self.backend = backend
        self.sendFrame = sendFrame
        self.now = now
    }

    public func start() async -> AudioRelayStartResult {
        guard state != .active else { return .started }
        guard state != .starting else { return .unavailable }
        if state != .inactive {
            stop()
        }
        startAttempt &+= 1
        let attempt = startAttempt
        state = .starting

        guard await microphonePermissionIsGranted() else {
            guard isCurrentStartAttempt(attempt) else { return .cancelled }
            state = .inactive
            return .microphonePermissionDenied
        }

        guard isCurrentStartAttempt(attempt) else {
            return .cancelled
        }
        guard !Task.isCancelled else {
            cancelCurrentStartAttempt(attempt, stoppingBackend: false)
            return .cancelled
        }

        resetIncomingPlayback(unschedulingBackend: false)
        pendingSamples.removeAll(keepingCapacity: true)
        backend.lifecycleHandler = { [weak self] event in
            self?.handleBackendEvent(event)
        }

        do {
            try backend.startCapture { [weak self] samples in
                self?.capture(samples)
            }
            guard isCurrentStartAttempt(attempt) else {
                return .cancelled
            }
            guard !Task.isCancelled else {
                cancelCurrentStartAttempt(attempt, stoppingBackend: true)
                return .cancelled
            }
            state = .active
            return .started
        } catch {
            guard isCurrentStartAttempt(attempt) else { return .cancelled }
            backend.stop()
            backend.lifecycleHandler = nil
            state = .failed(.unavailable)
            return .unavailable
        }
    }

    public func stop() {
        startAttempt &+= 1
        backend.lifecycleHandler = nil
        resetIncomingPlayback(unschedulingBackend: true)
        backend.stop()
        pendingSamples.removeAll(keepingCapacity: true)
        state = .inactive
    }

    public func setMuted(_ muted: Bool) {
        isMuted = muted
    }

    /// Delivers a decoded network frame to the bounded jitter scheduler.
    public func receive(_ frame: AudioRelayEngine.DecodedAudioFrame) {
        guard state == .active,
              frame.senderId == targetUserId,
              frame.samples.count == AudioRelayEngine.samplesPerFrame else {
            return
        }

        incomingPlaybackFrames.append(frame)
        guard isIncomingPlaybackPrimed || incomingPlaybackFrames.count >= minimumIncomingFramesBeforePlayback else {
            return
        }
        isIncomingPlaybackPrimed = true
        scheduleNextIncomingPlayback()
    }

    private func scheduleNextIncomingPlayback() {
        guard let frame = incomingPlaybackFrames.popFirst() else { return }
        do {
            let scheduledTime = jitterScheduler.scheduleFrame(currentTime: now())
            try backend.schedulePlayback(samples: frame.samples, at: scheduledTime)
        } catch {
            fail(.playbackUnavailable)
        }
    }

    private func microphonePermissionIsGranted() async -> Bool {
        switch backend.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await backend.requestRecordPermission()
        }
    }

    private func capture(_ samples: [Float]) {
        guard state == .active, !isMuted else { return }

        pendingSamples.append(contentsOf: samples)
        while pendingSamples.count >= AudioRelayEngine.samplesPerFrame {
            let frameSamples = Array(pendingSamples.prefix(AudioRelayEngine.samplesPerFrame))
            pendingSamples.removeFirst(AudioRelayEngine.samplesPerFrame)
            if let frame = AudioRelayEngine.encodeFrame(samples: frameSamples, targetUserId: targetUserId) {
                sendFrame(frame)
            }
        }
    }

    private func resetIncomingPlayback(unschedulingBackend: Bool) {
        incomingPlaybackFrames.removeAll(keepingCapacity: true)
        isIncomingPlaybackPrimed = false
        jitterScheduler.reset()
        if unschedulingBackend {
            backend.resetPlayback()
        }
    }

    private func handleBackendEvent(_ event: AudioRelayBackendEvent) {
        switch event {
        case .interruptionBegan:
            guard state == .active else { return }
            backend.pause()
            resetIncomingPlayback(unschedulingBackend: true)
            state = .interrupted

        case .interruptionEnded(let shouldResume):
            guard state == .interrupted else { return }
            guard shouldResume else {
                onRecoveryRequired?(.unavailable)
                stop()
                return
            }
            do {
                try backend.reactivateAudioSession()
                try backend.resume()
                state = .active
            } catch {
                fail(.unavailable)
            }

        case .routeChanged:
            guard state == .active else { return }
            do {
                try backend.handleRouteChange()
                resetIncomingPlayback(unschedulingBackend: true)
            } catch {
                fail(.unavailable)
            }
        }
    }

    private func isCurrentStartAttempt(_ attempt: Int) -> Bool {
        startAttempt == attempt && state == .starting
    }

    private func cancelCurrentStartAttempt(_ attempt: Int, stoppingBackend: Bool) {
        guard isCurrentStartAttempt(attempt) else { return }
        if stoppingBackend {
            backend.stop()
        }
        backend.lifecycleHandler = nil
        resetIncomingPlayback(unschedulingBackend: false)
        pendingSamples.removeAll(keepingCapacity: true)
        state = .inactive
    }

    private func fail(_ failure: AudioRelayFailure) {
        startAttempt &+= 1
        backend.lifecycleHandler = nil
        resetIncomingPlayback(unschedulingBackend: true)
        backend.stop()
        pendingSamples.removeAll(keepingCapacity: true)
        state = .failed(failure)
    }
}

/// The production AVAudioEngine adapter. It emits normalized 16 kHz mono Float PCM
/// to `AudioCallRelay`, which owns framing and network transport.
@MainActor
public final class AVAudioEngineBackend: NSObject, AudioRelayBackend {
    public var lifecycleHandler: ((AudioRelayBackendEvent) -> Void)?

    public var recordPermission: AudioRecordPermission {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted:
            return .granted
        case .denied:
            return .denied
        case .undetermined:
            return .undetermined
        @unknown default:
            return .denied
        }
    }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playbackFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: AudioRelayPCMFormat.voiceRelay.sampleRate,
        channels: AudioRelayPCMFormat.voiceRelay.channelCount,
        interleaved: false
    )!
    private var captureHandler: (([Float]) -> Void)?
    private var notificationTokens: [NSObjectProtocol] = []
    private var isGraphAttached = false
    private var queuedPlayback = BoundedNewestQueue<QueuedPlayback>(capacity: 6)
    private var isPlaybackInFlight = false
    private var playbackGeneration = 0

    private struct QueuedPlayback {
        let buffer: AVAudioPCMBuffer
        let time: TimeInterval
    }

    public override init() {
        super.init()
    }

    public func requestRecordPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    public func startCapture(_ handler: @escaping ([Float]) -> Void) throws {
        try AudioSessionManager.shared.activateForCall()
        if notificationTokens.isEmpty {
            observeAudioSessionLifecycle()
        }
        captureHandler = handler
        attachGraphIfNeeded()

        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        let inputSampleRate = inputFormat.sampleRate
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: nil) { [weak self] buffer, _ in
            let monoSamples = Self.monoSamples(from: buffer)
            let normalized = Self.resample(
                monoSamples,
                from: inputSampleRate,
                to: AudioRelayPCMFormat.voiceRelay.sampleRate
            )
            guard !normalized.isEmpty else { return }
            Task { @MainActor [weak self] in
                self?.captureHandler?(normalized)
            }
        }

        if !engine.isRunning {
            try engine.start()
        }
        player.play()
    }

    public func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        resetPlayback()
        captureHandler = nil
        notificationTokens.forEach(NotificationCenter.default.removeObserver)
        notificationTokens.removeAll()
        AudioSessionManager.shared.endCallSession()
    }

    public func pause() {
        player.pause()
        engine.pause()
    }

    public func reactivateAudioSession() throws {
        try AudioSessionManager.shared.activateForCall()
    }

    public func resume() throws {
        if !engine.isRunning {
            try engine.start()
        }
        player.play()
    }

    public func handleRouteChange() throws {
        if engine.isRunning {
            engine.pause()
        }
        try engine.start()
        player.play()
    }

    public func resetPlayback() {
        playbackGeneration &+= 1
        queuedPlayback.removeAll(keepingCapacity: true)
        isPlaybackInFlight = false
        player.stop()
        if engine.isRunning {
            player.play()
        }
    }

    private func scheduleNextPlaybackIfNeeded() {
        guard !isPlaybackInFlight,
              let next = queuedPlayback.popFirst() else {
            return
        }
        isPlaybackInFlight = true
        let generation = playbackGeneration
        let delay = max(0, next.time - CACurrentMediaTime())
        let hostTime = mach_absolute_time() + AVAudioTime.hostTime(forSeconds: delay)
        player.scheduleBuffer(next.buffer, at: AVAudioTime(hostTime: hostTime), options: []) { [weak self] in
            Task { @MainActor [weak self] in
                self?.finishPlayback(generation: generation)
            }
        }
    }

    private func finishPlayback(generation: Int) {
        guard playbackGeneration == generation else { return }
        isPlaybackInFlight = false
        scheduleNextPlaybackIfNeeded()
    }

    public func schedulePlayback(samples: [Float], at time: TimeInterval) throws {
        guard samples.count == AudioRelayEngine.samplesPerFrame,
              let buffer = AVAudioPCMBuffer(
                pcmFormat: playbackFormat,
                frameCapacity: AVAudioFrameCount(samples.count)
              ),
              let output = buffer.floatChannelData?[0] else {
            throw AudioEngineError.invalidPCMBuffer
        }

        for (index, sample) in samples.enumerated() {
            output[index] = sample
        }
        buffer.frameLength = AVAudioFrameCount(samples.count)

        queuedPlayback.append(QueuedPlayback(buffer: buffer, time: time))
        scheduleNextPlaybackIfNeeded()
    }

    private func attachGraphIfNeeded() {
        guard !isGraphAttached else { return }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        isGraphAttached = true
    }

    private func observeAudioSessionLifecycle() {
        let notificationCenter = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        notificationTokens.append(notificationCenter.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            guard let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
                return
            }
            switch type {
            case .began:
                Task { @MainActor [weak self] in
                    self?.lifecycleHandler?(.interruptionBegan)
                }
            case .ended:
                let optionsValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                let event = AudioRelayBackendEvent.interruptionEnded(
                    shouldResume: options.contains(.shouldResume)
                )
                Task { @MainActor [weak self] in
                    self?.lifecycleHandler?(event)
                }
            @unknown default:
                break
            }
        })

        notificationTokens.append(notificationCenter.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: session,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.lifecycleHandler?(.routeChanged)
            }
        })
    }

    private nonisolated static func monoSamples(from buffer: AVAudioPCMBuffer) -> [Float] {
        guard let channels = buffer.floatChannelData else { return [] }
        let frameCount = Int(buffer.frameLength)
        let channelCount = max(1, Int(buffer.format.channelCount))
        var samples = [Float](repeating: 0, count: frameCount)

        for frame in 0..<frameCount {
            var sum: Float = 0
            for channel in 0..<channelCount {
                sum += channels[channel][frame]
            }
            samples[frame] = sum / Float(channelCount)
        }
        return samples
    }

    private nonisolated static func resample(_ samples: [Float], from sourceRate: Double, to targetRate: Double) -> [Float] {
        guard sourceRate > 0, targetRate > 0, !samples.isEmpty else { return [] }
        guard sourceRate != targetRate else { return samples }

        let outputCount = max(1, Int((Double(samples.count) * targetRate / sourceRate).rounded(.down)))
        let step = sourceRate / targetRate
        return (0..<outputCount).map { outputIndex in
            let sourcePosition = min(Double(samples.count - 1), Double(outputIndex) * step)
            let lowerIndex = Int(sourcePosition)
            let upperIndex = min(lowerIndex + 1, samples.count - 1)
            let fraction = Float(sourcePosition - Double(lowerIndex))
            return samples[lowerIndex] + (samples[upperIndex] - samples[lowerIndex]) * fraction
        }
    }
}

private enum AudioEngineError: Error {
    case invalidPCMBuffer
}
