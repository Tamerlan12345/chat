import XCTest
@testable import CentyChat

final class AudioRelayTests: XCTestCase {
    
    func testSilenceGatingDiscardsQuietFrame() {
        // Создаем 512 сэмплов с амплитудой ниже порога 0.0015
        let quietSamples = [Float](repeating: 0.0005, count: 512)
        let frame = AudioRelayEngine.encodeFrame(samples: quietSamples, targetUserId: 12)
        
        XCTAssertNil(frame, "Кадр с амплитудой ниже SILENCE_THRESHOLD (0.0015) должен быть отброшен")
    }
    
    func testActiveAudioFrameEncoding() {
        // Создаем 512 сэмплов активной речи (синусоида 0.5)
        let activeSamples = (0..<512).map { i in Float(sin(Double(i) * 0.1) * 0.5) }
        let frame = AudioRelayEngine.encodeFrame(samples: activeSamples, targetUserId: 42)
        
        XCTAssertNotNil(frame)
        XCTAssertEqual(frame?.count, 1028, "Размер бинарного фрейма должен быть ровно 1028 байт")
    }
    
    func testAudioFrameDecoding() {
        let activeSamples = (0..<512).map { i in Float(sin(Double(i) * 0.1) * 0.8) }
        let targetUserId: Int64 = 99
        guard let encoded = AudioRelayEngine.encodeFrame(samples: activeSamples, targetUserId: targetUserId) else {
            XCTFail("Encoding failed")
            return
        }
        
        let decoded = AudioRelayEngine.decodeFrame(data: encoded)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.senderId, targetUserId)
        XCTAssertEqual(decoded?.samples.count, 512)
        
        // Проверяем точность восстановления первого сэмпла
        if let originalFirst = activeSamples.first, let decodedFirst = decoded?.samples.first {
            XCTAssertEqual(originalFirst, decodedFirst, accuracy: 0.01)
        }
    }
    
    func testJitterSchedulerTargetAndMaxLead() {
        let scheduler = JitterScheduler()
        let currentTime: TimeInterval = 1000.0
        
        // Первый кадр планируется на currentTime + 60ms
        let firstScheduled = scheduler.scheduleFrame(currentTime: currentTime)
        XCTAssertEqual(firstScheduled, currentTime + 0.06, accuracy: 0.001)
        
        // Следующий кадр планируется через 32ms
        let secondScheduled = scheduler.scheduleFrame(currentTime: currentTime)
        XCTAssertEqual(secondScheduled, firstScheduled + 0.032, accuracy: 0.001)
        
        // Заполняем очередь до границы в 250 мс.
        for _ in 0..<4 {
            _ = scheduler.scheduleFrame(currentTime: currentTime)
        }

        // Следующий вызов должен заметить превышение 250мс и сброситься к 60мс.
        let resetScheduled = scheduler.scheduleFrame(currentTime: currentTime)
        XCTAssertEqual(resetScheduled, currentTime + 0.06, accuracy: 0.001)
    }

    func testCaptureNormalizerUsesTheCurrentBufferSampleRate() {
        let samples: [Float] = [0, 1, 0, -1]

        let builtInRoute = AudioCaptureNormalizer.normalize(
            samples,
            bufferSampleRate: 16_000
        )
        let bluetoothRoute = AudioCaptureNormalizer.normalize(
            samples,
            bufferSampleRate: 8_000
        )

        XCTAssertEqual(builtInRoute, [0, 1, 0, -1])
        XCTAssertEqual(bluetoothRoute, [0, 0.5, 1, 0.5, 0, -0.5, -1, -1])
    }
}

@MainActor
final class WebSocketAudioStreamTests: XCTestCase {
    func testIncomingAudioDropsOldestFramesUnderBackpressure() async {
        let client = WebSocketClient()
        let stream = await client.incomingAudio

        for senderId in 1...9 {
            await client.receiveIncomingAudioFrame(makeAudioFrame(senderId: Int64(senderId)))
        }

        var iterator = stream.makeAsyncIterator()
        var receivedSenderIDs: [Int64] = []
        for _ in 0..<8 {
            guard let frame = await iterator.next() else {
                return XCTFail("The audio stream ended before its bounded buffer was drained")
            }
            receivedSenderIDs.append(frame.senderId)
        }

        XCTAssertEqual(receivedSenderIDs, Array(2...9).map(Int64.init))
    }

    func testReplacingIncomingAudioSubscriberFinishesOldStreamAndKeepsNewStreamLive() async {
        let client = WebSocketClient()
        let firstStream = await client.incomingAudio
        let firstStreamEnded = expectation(description: "first stream ended")

        Task { @MainActor in
            var iterator = firstStream.makeAsyncIterator()
            let finishedFrame = await iterator.next()
            XCTAssertNil(finishedFrame)
            firstStreamEnded.fulfill()
        }
        await Task.yield()

        let secondStream = await client.incomingAudio
        await fulfillment(of: [firstStreamEnded], timeout: 1)
        await Task.yield()

        let secondStreamReceivedFrame = expectation(description: "second stream received a frame")
        await client.receiveIncomingAudioFrame(makeAudioFrame(senderId: 42))
        Task { @MainActor in
            var iterator = secondStream.makeAsyncIterator()
            let receivedFrame = await iterator.next()
            XCTAssertEqual(receivedFrame?.senderId, 42)
            secondStreamReceivedFrame.fulfill()
        }

        await fulfillment(of: [secondStreamReceivedFrame], timeout: 1)
    }

    func testDisconnectFinishesIncomingAudioStream() async {
        let client = WebSocketClient()
        let stream = await client.incomingAudio
        let streamEnded = expectation(description: "audio stream ended")

        Task { @MainActor in
            var iterator = stream.makeAsyncIterator()
            let finishedFrame = await iterator.next()
            XCTAssertNil(finishedFrame)
            streamEnded.fulfill()
        }
        await Task.yield()

        await client.disconnect()

        await fulfillment(of: [streamEnded], timeout: 1)
    }

    private func makeAudioFrame(senderId: Int64) -> Data {
        guard let frame = AudioRelayEngine.encodeFrame(
            samples: [Float](repeating: 0.5, count: AudioRelayEngine.samplesPerFrame),
            targetUserId: senderId
        ) else {
            fatalError("The non-silent test fixture must encode")
        }
        return frame
    }
}
