import AVFoundation
import XCTest
@testable import CentyChat

/// AVFoundation invokes tap and scheduleBuffer callbacks on its own threads. Under Swift 6
/// these callbacks must be nonisolated and Sendable, hopping to the main actor only for state.
/// The handlers are built and invoked entirely off the main actor here: a main-actor-isolated
/// factory or a non-Sendable handler does not compile under Swift 6 strict concurrency.
@MainActor
final class AudioEngineCallbackIsolationTests: XCTestCase {
    func testCaptureTapInvokedFromBackgroundQueueDeliversNormalizedSamplesOnMainActor() async {
        let delivered = expectation(description: "normalized capture samples delivered on the main actor")

        DispatchQueue.global(qos: .userInteractive).async {
            XCTAssertFalse(Thread.isMainThread)
            let tap = AVAudioEngineBackend.makeCaptureTapBlock { samples in
                XCTAssertTrue(Thread.isMainThread)
                XCTAssertEqual(samples.count, 320, "960 frames at 48 kHz normalize to 320 frames at 16 kHz.")
                XCTAssertEqual(samples.first ?? 0, 0.25, accuracy: 0.0001, "Stereo input is averaged to mono.")
                delivered.fulfill()
            }
            guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960),
                  let channels = buffer.floatChannelData else {
                return XCTFail("Unable to allocate a stereo capture buffer.")
            }
            buffer.frameLength = 960
            for frame in 0..<960 {
                channels[0][frame] = 0.5
                channels[1][frame] = 0
            }
            tap(buffer, AVAudioTime(hostTime: 0))
        }

        await fulfillment(of: [delivered], timeout: 2)
    }

    func testPlaybackCompletionInvokedFromBackgroundQueueHopsToMainActor() async {
        let finished = expectation(description: "playback completion delivered on the main actor")

        DispatchQueue.global(qos: .userInteractive).async {
            XCTAssertFalse(Thread.isMainThread)
            let completion = AVAudioEngineBackend.makePlaybackCompletionHandler(generation: 7) { generation in
                XCTAssertTrue(Thread.isMainThread)
                XCTAssertEqual(generation, 7)
                finished.fulfill()
            }
            completion()
        }

        await fulfillment(of: [finished], timeout: 2)
    }
}
