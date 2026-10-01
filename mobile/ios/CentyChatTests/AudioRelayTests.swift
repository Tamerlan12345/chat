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
        
        // Симулируем накопление задержки свыше 250 мс
        // Допустим, мы вызываем scheduleFrame при текущем времени 1000.0, но очередь убежала на +0.300с
        let futureTime: TimeInterval = currentTime
        for _ in 0..<15 {
            _ = scheduler.scheduleFrame(currentTime: futureTime)
        }
        
        // Следующий вызов должен заметить превышение 250мс и сброситься к 60мс
        let resetScheduled = scheduler.scheduleFrame(currentTime: currentTime)
        XCTAssertEqual(resetScheduled, currentTime + 0.06, accuracy: 0.001)
    }
}
