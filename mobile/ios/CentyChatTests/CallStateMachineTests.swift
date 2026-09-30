import XCTest
@testable import CentyChat

final class CallStateMachineTests: XCTestCase {
    
    func testInitialCallSessionState() {
        let session = CallSession(
            peerId: 12,
            peerName: "Данияр Нурпеисов",
            state: .idle,
            direction: .outgoing
        )
        
        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(session.duration, 0)
        XCTAssertFalse(session.isMuted)
        XCTAssertFalse(session.isSpeakerOn)
        XCTAssertNil(session.endReason)
    }
    
    func testOutgoingCallLifecycle() {
        var session = CallSession(
            peerId: 12,
            peerName: "Данияр Нурпеисов",
            state: .calling,
            direction: .outgoing
        )
        XCTAssertEqual(session.state, .calling)
        XCTAssertFalse(session.state.isTerminal)
        
        // Собеседник ответил
        session.state = .connecting
        XCTAssertEqual(session.state, .connecting)
        
        session.state = .active
        session.startedAt = Date()
        session.duration = 45
        XCTAssertEqual(session.formattedDuration, "00:45")
        
        // Завершение звонка
        session.state = .ended
        session.endReason = .normal
        XCTAssertTrue(session.state.isTerminal)
        XCTAssertEqual(session.endReason, .normal)
    }
    
    func testIncomingCallRejection() {
        var session = CallSession(
            peerId: 7,
            peerName: "Канат Ахметов",
            state: .ringing,
            direction: .incoming
        )
        XCTAssertEqual(session.state, .ringing)
        
        // Отклонение вызова
        session.state = .failed
        session.endReason = .rejected
        XCTAssertTrue(session.state.isTerminal)
        XCTAssertEqual(session.endReason, .rejected)
    }
    
    func testDurationFormatting() {
        var session = CallSession(peerId: 1, peerName: "Тест")
        
        session.duration = 0
        XCTAssertEqual(session.formattedDuration, "00:00")
        
        session.duration = 65
        XCTAssertEqual(session.formattedDuration, "01:05")
        
        session.duration = 632
        XCTAssertEqual(session.formattedDuration, "10:32")
    }
}
