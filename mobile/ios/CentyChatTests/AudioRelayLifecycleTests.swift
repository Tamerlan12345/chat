import XCTest
@testable import CentyChat

@MainActor
final class AudioRelayLifecycleTests: XCTestCase {
    func testDeniedMicrophonePermissionKeepsRelayInactive() async {
        let backend = FakeAudioRelayBackend(permission: .denied)
        let relay = AudioCallRelay(targetUserId: 42, backend: backend, sendFrame: { _ in })

        let result = await relay.start()

        XCTAssertEqual(result, .microphonePermissionDenied)
        XCTAssertEqual(relay.state, .inactive)
        XCTAssertEqual(backend.startCount, 0)
        XCTAssertEqual(backend.permissionRequestCount, 0)
    }

    func testUndeterminedMicrophonePermissionDeniedByUserKeepsRelayInactive() async {
        let backend = FakeAudioRelayBackend(permission: .undetermined, permissionRequestResult: false)
        let relay = AudioCallRelay(targetUserId: 42, backend: backend, sendFrame: { _ in })

        let result = await relay.start()

        XCTAssertEqual(result, .microphonePermissionDenied)
        XCTAssertEqual(relay.state, .inactive)
        XCTAssertEqual(backend.permissionRequestCount, 1)
        XCTAssertEqual(backend.startCount, 0)
    }

    func testStoppingDuringPermissionRequestCancelsRelayStart() async {
        let permissionRequestStarted = expectation(description: "permission request started")
        let backend = FakeAudioRelayBackend(
            permission: .undetermined,
            suspendPermissionRequest: true
        )
        backend.onPermissionRequestStarted = { permissionRequestStarted.fulfill() }
        let relay = AudioCallRelay(targetUserId: 42, backend: backend, sendFrame: { _ in })

        let startTask = Task { @MainActor in
            await relay.start()
        }
        await fulfillment(of: [permissionRequestStarted], timeout: 1)

        relay.stop()
        backend.resolvePermissionRequest(granted: true)

        let startResult = await startTask.value
        XCTAssertEqual(startResult, .cancelled)
        XCTAssertEqual(relay.state, .inactive)
        XCTAssertNil(backend.lifecycleHandler)
        XCTAssertEqual(backend.startCount, 0)
        XCTAssertEqual(backend.stopCount, 1)
    }

    func testCancellingTaskDuringPermissionRequestLeavesRelayInactive() async {
        let permissionRequestStarted = expectation(description: "permission request started")
        let backend = FakeAudioRelayBackend(
            permission: .undetermined,
            suspendPermissionRequest: true
        )
        backend.onPermissionRequestStarted = { permissionRequestStarted.fulfill() }
        let relay = AudioCallRelay(targetUserId: 42, backend: backend, sendFrame: { _ in })

        let startTask = Task { @MainActor in
            await relay.start()
        }
        await fulfillment(of: [permissionRequestStarted], timeout: 1)

        startTask.cancel()
        backend.resolvePermissionRequest(granted: true)

        let startResult = await startTask.value
        XCTAssertEqual(startResult, .cancelled)
        XCTAssertEqual(relay.state, .inactive)
        XCTAssertNil(backend.lifecycleHandler)
        XCTAssertEqual(backend.startCount, 0)
    }

    func testCapturedPCMIsFramedAs16KilohertzMono() async {
        let backend = FakeAudioRelayBackend(permission: .granted)
        var sentFrames: [Data] = []
        let relay = AudioCallRelay(targetUserId: 0x0102_0304, backend: backend) { frame in
            sentFrames.append(frame)
        }

        let result = await relay.start()
        XCTAssertEqual(result, .started)
        XCTAssertEqual(AudioRelayPCMFormat.voiceRelay.sampleRate, 16_000)
        XCTAssertEqual(AudioRelayPCMFormat.voiceRelay.channelCount, 1)
        XCTAssertEqual(AudioRelayPCMFormat.voiceRelay.bitsPerChannel, 16)

        backend.emitCapturedSamples([Float](repeating: 0.5, count: AudioRelayEngine.samplesPerFrame))

        XCTAssertEqual(sentFrames.count, 1)
        guard let frame = sentFrames.first,
              let decoded = AudioRelayEngine.decodeFrame(data: frame) else {
            return XCTFail("Expected one valid PCM frame")
        }
        XCTAssertEqual(frame.count, AudioRelayEngine.frameSizeBytes)
        XCTAssertEqual(decoded.senderId, 0x0102_0304)
        XCTAssertEqual(decoded.samples.count, AudioRelayEngine.samplesPerFrame)
        XCTAssertEqual(decoded.samples[0], 0.5, accuracy: 0.001)
    }

    func testIncomingPeerFrameSchedulesBoundedPlayback() async {
        let backend = FakeAudioRelayBackend(permission: .granted)
        let relay = AudioCallRelay(
            targetUserId: 42,
            backend: backend,
            sendFrame: { _ in },
            now: { 100 }
        )

        let result = await relay.start()
        XCTAssertEqual(result, .started)
        let frame = AudioRelayEngine.DecodedAudioFrame(
            senderId: 42,
            samples: [Float](repeating: 0.25, count: AudioRelayEngine.samplesPerFrame)
        )

        for _ in 0..<10 {
            relay.receive(frame)
        }
        relay.receive(AudioRelayEngine.DecodedAudioFrame(senderId: 999, samples: frame.samples))

        XCTAssertEqual(backend.scheduledPlayback.count, 9)
        XCTAssertTrue(backend.scheduledPlayback.allSatisfy { $0.samples.count == AudioRelayEngine.samplesPerFrame })
        XCTAssertTrue(backend.scheduledPlayback.allSatisfy {
            $0.time >= 100 + JitterScheduler.targetLeadSeconds &&
            $0.time <= 100 + JitterScheduler.maxLeadSeconds
        })
    }

    func testRouteChangeDuringInterruptionDoesNotRestartAudio() async {
        let backend = FakeAudioRelayBackend(permission: .granted)
        let relay = AudioCallRelay(targetUserId: 42, backend: backend, sendFrame: { _ in })

        let startResult = await relay.start()
        XCTAssertEqual(startResult, .started)
        backend.emit(.interruptionBegan)
        backend.emit(.routeChanged)

        XCTAssertEqual(relay.state, .interrupted)
        XCTAssertEqual(backend.pauseCount, 1)
        XCTAssertEqual(backend.routeChangeCount, 0)
        XCTAssertEqual(backend.resetPlaybackCount, 1)
        XCTAssertEqual(backend.resumeCount, 0)
    }

    func testResumeReactivatesAudioSessionBeforeEngine() async {
        let backend = FakeAudioRelayBackend(permission: .granted)
        let relay = AudioCallRelay(targetUserId: 42, backend: backend, sendFrame: { _ in })

        let startResult = await relay.start()
        XCTAssertEqual(startResult, .started)
        backend.emit(.interruptionBegan)
        backend.emit(.interruptionEnded(shouldResume: true))

        XCTAssertEqual(relay.state, .active)
        XCTAssertEqual(Array(backend.lifecycleOperations.suffix(2)), ["reactivateAudioSession", "resume"])
    }

    func testRouteChangeDiscardsStaleScheduledPlayback() async {
        let backend = FakeAudioRelayBackend(permission: .granted)
        let relay = AudioCallRelay(
            targetUserId: 42,
            backend: backend,
            sendFrame: { _ in },
            now: { 100 }
        )
        let frame = AudioRelayEngine.DecodedAudioFrame(
            senderId: 42,
            samples: [Float](repeating: 0.25, count: AudioRelayEngine.samplesPerFrame)
        )

        let startResult = await relay.start()
        XCTAssertEqual(startResult, .started)
        relay.receive(frame)
        relay.receive(frame)
        XCTAssertEqual(backend.scheduledPlayback.count, 1)

        backend.emit(.routeChanged)

        XCTAssertEqual(relay.state, .active)
        XCTAssertEqual(backend.routeChangeCount, 1)
        XCTAssertEqual(backend.resetPlaybackCount, 1)
        XCTAssertTrue(backend.scheduledPlayback.isEmpty)
    }

    func testNewestFrameQueueDropsOldestFramesAtCapacity() {
        var queue = BoundedNewestQueue<Int>(capacity: 3)

        for frame in 1...5 {
            queue.append(frame)
        }

        XCTAssertEqual(queue.elements, [3, 4, 5])
    }

    func testInterruptionAndRouteChangeRecoverOnlyWhenTheSystemAllowsIt() async {
        let backend = FakeAudioRelayBackend(permission: .granted)
        let relay = AudioCallRelay(targetUserId: 42, backend: backend, sendFrame: { _ in })

        let result = await relay.start()
        XCTAssertEqual(result, .started)
        backend.emit(.interruptionBegan)
        XCTAssertEqual(relay.state, .interrupted)
        XCTAssertEqual(backend.pauseCount, 1)

        backend.emit(.interruptionEnded(shouldResume: true))
        XCTAssertEqual(relay.state, .active)
        XCTAssertEqual(backend.resumeCount, 1)

        backend.emit(.routeChanged)
        XCTAssertEqual(relay.state, .active)
        XCTAssertEqual(backend.routeChangeCount, 1)

        backend.emit(.interruptionBegan)
        backend.emit(.interruptionEnded(shouldResume: false))
        XCTAssertEqual(relay.state, .inactive)
        XCTAssertEqual(backend.stopCount, 1)
    }

    func testOutgoingCallDoesNotStartMicrophoneBeforePeerAnswer() async {
        let backend = FakeAudioRelayBackend(permission: .granted)
        let calls = makeCallStore(backend: backend)
        let peer = PublicUser(id: 42, username: "peer", fullName: "Peer")

        await calls.startOutgoingCall(targetUser: peer)

        XCTAssertEqual(calls.activeCall?.state, .calling)
        XCTAssertEqual(backend.startCount, 0)
    }

    func testPeerAnswerWithDeniedMicrophoneDoesNotActivateOutgoingCall() async {
        let backend = FakeAudioRelayBackend(permission: .denied)
        let calls = makeCallStore(backend: backend)
        calls.activeCall = CallSession(
            peerId: 42,
            peerName: "Peer",
            state: .calling,
            direction: .outgoing
        )

        await calls.activateAcceptedOutgoingCall(for: 42)

        XCTAssertEqual(calls.activeCall?.state, .failed)
        XCTAssertEqual(calls.activeCall?.endReason, .micPermissionDenied)
        XCTAssertEqual(backend.startCount, 0)
        XCTAssertNotNil(calls.callAudioError)
        XCTAssertTrue(calls.callAudioRequiresMicrophonePermission)
    }

    private func makeCallStore(backend: FakeAudioRelayBackend) -> CallStore {
        CallStore(
            realtime: RealtimeStore(repository: FakeRealtimeRepository()),
            audioRelayFactory: { peerId in
                AudioCallRelay(targetUserId: peerId, backend: backend, sendFrame: { _ in })
            }
        )
    }
}

@MainActor
private final class FakeAudioRelayBackend: AudioRelayBackend {
    struct ScheduledPlayback {
        let samples: [Float]
        let time: TimeInterval
    }

    var recordPermission: AudioRecordPermission
    var permissionRequestResult: Bool
    var suspendPermissionRequest: Bool
    var lifecycleHandler: ((AudioRelayBackendEvent) -> Void)?
    private var captureHandler: (([Float]) -> Void)?
    private var permissionContinuation: CheckedContinuation<Bool, Never>?
    var onPermissionRequestStarted: (() -> Void)?

    private(set) var permissionRequestCount = 0
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private(set) var pauseCount = 0
    private(set) var resumeCount = 0
    private(set) var routeChangeCount = 0
    private(set) var resetPlaybackCount = 0
    private(set) var scheduledPlayback: [ScheduledPlayback] = []
    private(set) var lifecycleOperations: [String] = []

    init(
        permission: AudioRecordPermission,
        permissionRequestResult: Bool = true,
        suspendPermissionRequest: Bool = false
    ) {
        self.recordPermission = permission
        self.permissionRequestResult = permissionRequestResult
        self.suspendPermissionRequest = suspendPermissionRequest
    }

    func requestRecordPermission() async -> Bool {
        permissionRequestCount += 1
        if suspendPermissionRequest {
            return await withCheckedContinuation { continuation in
                permissionContinuation = continuation
                onPermissionRequestStarted?()
            }
        }
        if permissionRequestResult {
            recordPermission = .granted
        }
        return permissionRequestResult
    }

    func resolvePermissionRequest(granted: Bool) {
        recordPermission = granted ? .granted : .denied
        let continuation = permissionContinuation
        permissionContinuation = nil
        continuation?.resume(returning: granted)
    }

    func startCapture(_ handler: @escaping ([Float]) -> Void) throws {
        startCount += 1
        captureHandler = handler
    }

    func stop() {
        stopCount += 1
        captureHandler = nil
    }

    func pause() {
        pauseCount += 1
    }

    func resume() throws {
        resumeCount += 1
        lifecycleOperations.append("resume")
    }

    func reactivateAudioSession() throws {
        lifecycleOperations.append("reactivateAudioSession")
    }

    func handleRouteChange() throws {
        routeChangeCount += 1
    }

    func resetPlayback() {
        resetPlaybackCount += 1
        scheduledPlayback.removeAll()
    }

    func schedulePlayback(samples: [Float], at time: TimeInterval) throws {
        scheduledPlayback.append(ScheduledPlayback(samples: samples, time: time))
    }

    func emitCapturedSamples(_ samples: [Float]) {
        captureHandler?(samples)
    }

    func emit(_ event: AudioRelayBackendEvent) {
        lifecycleHandler?(event)
    }
}
