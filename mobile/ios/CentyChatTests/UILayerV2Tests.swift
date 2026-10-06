import Foundation
import UIKit
import XCTest
@testable import CentyChat

/// The connection banner (design brief «UI layer v2», component 8): «Нет сети» / «Переподключение…»
/// slide in after a short grace period, «Снова в сети» shows after a problem and collapses by itself.
/// Same machine as Android's `ConnectionBannerMachine`.
final class ConnectionBannerMachineTests: XCTestCase {
    func testAConnectedLinkHasNoProblem() {
        XCTAssertNil(ConnectionBannerMachine.problem(.connected, networkAvailable: false, isRunning: true))
    }

    func testNoNetworkIsOfflineAndAnythingElseIsReconnecting() {
        XCTAssertEqual(ConnectionBannerMachine.problem(.connecting, networkAvailable: false, isRunning: true), .offline)
        XCTAssertEqual(ConnectionBannerMachine.problem(.reconnecting(attempt: 2, delay: 2), networkAvailable: true, isRunning: true), .reconnecting)
        XCTAssertEqual(ConnectionBannerMachine.problem(.connecting, networkAvailable: nil, isRunning: true), .reconnecting)
    }

    func testASignedOutAppSaysNothing() {
        XCTAssertNil(ConnectionBannerMachine.problem(.disconnected, networkAvailable: false, isRunning: false))
    }

    func testAProblemShowsAndItsKindCanChange() {
        XCTAssertEqual(ConnectionBannerMachine.onLink(.hidden, .reconnecting), .problem(.reconnecting))
        XCTAssertEqual(ConnectionBannerMachine.onLink(.problem(.reconnecting), .offline), .problem(.offline))
    }

    func testRecoveryAfterAProblemSaysBackOnlineThenHides() {
        XCTAssertEqual(ConnectionBannerMachine.onLink(.problem(.offline), nil), .backOnline)
        XCTAssertEqual(ConnectionBannerMachine.onBackOnlineElapsed(.backOnline), .hidden)
        XCTAssertEqual(ConnectionBannerMachine.backOnlineDuration, .milliseconds(1_200))
    }

    func testAHealthyLinkNeverAnnouncesItself() {
        XCTAssertEqual(ConnectionBannerMachine.onLink(.hidden, nil), .hidden)
        XCTAssertEqual(ConnectionBannerMachine.onLink(.backOnline, nil), .backOnline)
    }

    func testANewProblemInterruptsBackOnlineAndTheTimerOnlyClosesBackOnline() {
        XCTAssertEqual(ConnectionBannerMachine.onLink(.backOnline, .offline), .problem(.offline))
        XCTAssertEqual(ConnectionBannerMachine.onBackOnlineElapsed(.problem(.offline)), .problem(.offline))
    }
}

/// What VoiceOver was told.
@MainActor
final class Spoken {
    var items: [String] = []
}

@MainActor
final class ConnectionStatusTests: XCTestCase {
    private func wait(_ milliseconds: Int) async {
        try? await Task.sleep(for: .milliseconds(milliseconds))
    }

    func testAShortDropInsideTheGracePeriodIsNeverShown() async {
        let status = ConnectionStatus(grace: .milliseconds(300), backOnline: .milliseconds(50))
        status.connectionChanged(.reconnecting(attempt: 1, delay: 1), isRunning: true)
        await wait(100)
        status.connectionChanged(.connected, isRunning: true)
        await wait(400)
        XCTAssertEqual(status.phase, .hidden)
    }

    func testEveryShownPhaseIsAnnouncedToVoiceOver() {
        let said = Spoken()
        let status = ConnectionStatus(grace: .zero, backOnline: .seconds(5), announce: { said.items.append($0) })
        status.connectionChanged(.reconnecting(attempt: 1, delay: 1), isRunning: true)
        status.networkChanged(available: false)
        status.networkChanged(available: true)
        status.connectionChanged(.connected, isRunning: true)
        XCTAssertEqual(said.items, ["Переподключение…", "Нет сети", "Переподключение…", "Снова в сети"])
    }

    func testSigningOutDuringAProblemIsNotAnnouncedAsBackOnline() {
        let said = Spoken()
        let status = ConnectionStatus(grace: .zero, backOnline: .seconds(5), announce: { said.items.append($0) })
        status.connectionChanged(.reconnecting(attempt: 1, delay: 1), isRunning: true)
        // Sign-out: the session stops listening on the way to the login screen.
        status.connectionChanged(.disconnected, isRunning: false)
        XCTAssertEqual(said.items, ["Переподключение…"], "No «Снова в сети» on the way to login")
    }

    func testALastingDropShowsThenRecoversThroughBackOnline() async {
        let status = ConnectionStatus(grace: .milliseconds(50), backOnline: .milliseconds(150))
        status.connectionChanged(.reconnecting(attempt: 1, delay: 1), isRunning: true)
        await wait(150)
        XCTAssertEqual(status.phase, .problem(.reconnecting))
        status.networkChanged(available: false)
        XCTAssertEqual(status.phase, .problem(.offline), "A visible banner changes its kind at once")
        status.networkChanged(available: true)
        status.connectionChanged(.connected, isRunning: true)
        XCTAssertEqual(status.phase, .backOnline)
        await wait(300)
        XCTAssertEqual(status.phase, .hidden)
    }
}

/// «At the end of the chat» is inset-aware: the bars above the list are a top inset larger than the
/// tolerance, so a check on offset + container alone never sees the end of a long history.
final class ChatScrollEndTests: XCTestCase {
    func testTheEndBehindATallTopInsetCountsAsTheEnd() {
        // 2 000-pt history, 640-pt container under a 140-pt top inset, scrolled to the end.
        XCTAssertTrue(ChatScrollEnd.isAtEnd(visibleMaxY: 1_860, offsetY: 1_220, containerHeight: 640, topInset: 140, contentHeight: 2_000))
        XCTAssertTrue(ChatScrollEnd.isAtEnd(visibleMaxY: 2_000, offsetY: 1_360, containerHeight: 640, topInset: 0, contentHeight: 2_000))
    }

    func testScrolledUpIsNotTheEnd() {
        XCTAssertFalse(ChatScrollEnd.isAtEnd(visibleMaxY: 1_500, offsetY: 720, containerHeight: 640, topInset: 140, contentHeight: 2_000))
    }
}

/// Section stagger in the search and in «Отделы»: capped, and none with Reduce Motion.
final class StaggerTests: XCTestCase {
    func testDepartmentChildrenStaggerTwentyMillisecondsUpToSix() {
        XCTAssertEqual(Stagger.departmentRow(index: 0, reduceMotion: false), 0, accuracy: 0.0001)
        XCTAssertEqual(Stagger.departmentRow(index: 3, reduceMotion: false), 0.06, accuracy: 0.0001)
        XCTAssertEqual(Stagger.departmentRow(index: 40, reduceMotion: false), 0.10, accuracy: 0.0001, "Cap 6 × 20 ms")
    }

    func testSearchSectionsStaggerThirtyMillisecondsForAtMostThreeItems() {
        XCTAssertEqual(Stagger.searchItem(index: 1, reduceMotion: false), 0.03, accuracy: 0.0001)
        XCTAssertEqual(Stagger.searchItem(index: 9, reduceMotion: false), 0.06, accuracy: 0.0001)
    }

    func testReduceMotionRemovesTheStagger() {
        XCTAssertEqual(Stagger.departmentRow(index: 5, reduceMotion: true), 0)
        XCTAssertEqual(Stagger.searchItem(index: 2, reduceMotion: true), 0)
    }
}

/// The call stage's live five-bar meter from the peer's audio RMS.
final class AudioLevelTests: XCTestCase {
    func testRMSOfAFrame() {
        XCTAssertEqual(AudioLevel.rms([0.5, -0.5, 0.5, -0.5]), 0.5, accuracy: 0.0001)
        XCTAssertEqual(AudioLevel.rms([]), 0)
    }

    func testLevelIsDecibelsMappedToZeroOne() {
        XCTAssertEqual(AudioLevel.normalized(1), 1, accuracy: 0.001)
        XCTAssertEqual(AudioLevel.normalized(0), 0)
        XCTAssertEqual(AudioLevel.normalized(0.001), 0, accuracy: 0.001, "-60 dB is silence")
        XCTAssertEqual(AudioLevel.normalized(0.0562), 0.5, accuracy: 0.02, "-25 dB is half way")
    }

    func testBarsLitForALevel() {
        XCTAssertEqual(AudioLevel.litBars(0), 0)
        XCTAssertEqual(AudioLevel.litBars(0.5), 3)
        XCTAssertEqual(AudioLevel.litBars(1), 5)
    }
}

@MainActor
final class CallLevelTests: XCTestCase {
    func testThePeersVoiceDrivesTheLevelDuringACall() {
        let calls = CallStore(
            realtime: RealtimeStore(repository: FakeRealtimeRepository()),
            audioRelayFactory: { peerId in AudioCallRelay(targetUserId: peerId, backend: SilentAudioBackend(), sendFrame: { _ in }) }
        )
        calls.activeCall = CallSession(peerId: 42, peerName: "Коллега", state: .active, direction: .outgoing)
        calls.receiveAudio(AudioRelayEngine.DecodedAudioFrame(senderId: 42, samples: Array(repeating: 0.6, count: 64)))
        XCTAssertGreaterThan(calls.peerLevel, 0.8)
        calls.stopCallSession()
        XCTAssertEqual(calls.peerLevel, 0)
    }
}

/// Bubble grouping radii: 8, joined corners 4 inside a group, the 2-pt tail only on the first.
final class BubbleCornersTests: XCTestCase {
    func testASingleOwnBubbleHasTheTailTopTrailing() {
        let corners = BubbleCorners.of(isOwn: true, startsGroup: true, endsGroup: true)
        XCTAssertEqual(corners, BubbleCorners(topLeading: 8, bottomLeading: 8, bottomTrailing: 8, topTrailing: 2))
    }

    func testIncomingGroupJoinsOnTheSenderSide() {
        XCTAssertEqual(
            BubbleCorners.of(isOwn: false, startsGroup: true, endsGroup: false),
            BubbleCorners(topLeading: 2, bottomLeading: 4, bottomTrailing: 8, topTrailing: 8)
        )
        XCTAssertEqual(
            BubbleCorners.of(isOwn: false, startsGroup: false, endsGroup: false),
            BubbleCorners(topLeading: 4, bottomLeading: 4, bottomTrailing: 8, topTrailing: 8),
            "No tail in the middle of a group"
        )
        XCTAssertEqual(
            BubbleCorners.of(isOwn: false, startsGroup: false, endsGroup: true),
            BubbleCorners(topLeading: 4, bottomLeading: 8, bottomTrailing: 8, topTrailing: 8)
        )
    }
}

/// Date separators and inbox times: Russian, cached format styles, whatever the device region.
final class ChatDatesTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Almaty")!
        return calendar
    }

    /// 2026-10-05 (Monday) 18:00 in Almaty.
    private let now = Date(timeIntervalSince1970: 1_791_205_200)

    private func date(_ hoursAgo: Double) -> Date {
        now.addingTimeInterval(-hoursAgo * 3_600)
    }

    func testDaySeparators() {
        XCTAssertEqual(ChatDates.dayLabel(date(2), now: now, calendar: calendar), "Сегодня")
        XCTAssertEqual(ChatDates.dayLabel(date(24), now: now, calendar: calendar), "Вчера")
        XCTAssertEqual(ChatDates.dayLabel(date(24 * 20), now: now, calendar: calendar), "15 сентября")
        XCTAssertTrue(ChatDates.dayLabel(date(24 * 400), now: now, calendar: calendar).contains("2025"), "Another year names it")
    }

    func testInboxTimes() {
        XCTAssertEqual(ChatDates.inboxTime(date(2), now: now, calendar: calendar), "16:00")
        XCTAssertEqual(ChatDates.inboxTime(date(24), now: now, calendar: calendar), "Вчера")
        XCTAssertEqual(ChatDates.inboxTime(date(24 * 3), now: now, calendar: calendar).lowercased(), "пт")
        XCTAssertEqual(ChatDates.inboxTime(date(24 * 400), now: now, calendar: calendar), "31.08.25")
    }
}

/// «Скопировано» stays for its full time after the last copy; an earlier timer never hides it.
@MainActor
final class TransientFlagTests: XCTestCase {
    func testARepeatedShowRestartsTheTimer() async {
        let flag = TransientFlag()
        flag.show(for: .milliseconds(400))
        try? await Task.sleep(for: .milliseconds(250))
        flag.show(for: .milliseconds(400))
        try? await Task.sleep(for: .milliseconds(250))
        XCTAssertTrue(flag.isOn, "The first timer must not hide the second copy's HUD")
        try? await Task.sleep(for: .milliseconds(350))
        XCTAssertFalse(flag.isOn)
    }
}

/// Decoded avatar photos are kept on the main actor, so a row scrolled back shows the photo at once
/// (no initials flash); the memo belongs to the session and is wiped with it.
@MainActor
final class AvatarImageMemoTests: XCTestCase {
    private func image() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
    }

    func testAStoredPhotoIsReturnedSynchronously() {
        let memo = AvatarImageMemo()
        let photo = image()
        memo.store(photo, for: "https://chat.example.com/api/users/2/avatar?v=1&size=s")
        XCTAssertTrue(memo.image(for: "https://chat.example.com/api/users/2/avatar?v=1&size=s") === photo)
        XCTAssertNil(memo.image(for: "https://chat.example.com/api/users/2/avatar?v=2&size=s"))
    }

    func testAnInlinePhotoIsDecodedOnce() throws {
        let png = try XCTUnwrap(image().pngData())
        let dataURL = "data:image/png;base64," + png.base64EncodedString()
        let memo = AvatarImageMemo()
        let first = try XCTUnwrap(memo.inlineImage(dataURL))
        XCTAssertTrue(memo.inlineImage(dataURL) === first)
    }

    func testTheSessionEndWipesTheMemo() async {
        let app = TestApp()
        app.container.avatarMemo.store(image(), for: "photo")
        await app.container.sessionDidEnd()
        XCTAssertNil(app.container.avatarMemo.image(for: "photo"))
    }
}

/// Anti-generated polish rule 6: a tab counts unread conversations, not messages, and the active
/// tab carries no badge.
@MainActor
final class TabBadgeTests: XCTestCase {
    func testTheChatsBadgeCountsConversationsWithUnreadMessages() {
        let app = TestApp()
        app.container.conversations.directConversations = [
            TestModels.direct(with: 2, unread: 7),
            TestModels.direct(with: 3, unread: 1),
            TestModels.direct(with: 4),
        ]
        app.container.conversations.channels = [TestModels.channel(id: 5, unread: 12)]
        XCTAssertEqual(app.container.conversations.unreadDirectConversations, 2)
        XCTAssertEqual(app.container.conversations.unreadChannelConversations, 1)
    }

    func testTheActiveTabHasNoBadge() {
        XCTAssertNil(TabBadge.text(3, isSelected: true))
        XCTAssertNil(TabBadge.text(0, isSelected: false))
        XCTAssertEqual(TabBadge.text(3, isSelected: false), "3")
        XCTAssertEqual(TabBadge.text(250, isSelected: false), "99+")
    }
}

/// The card opened from a chat header: «Написать» returns to that chat instead of stacking a copy.
@MainActor
final class NavigationRouterTests: XCTestCase {
    private let bob = ChatRoute(type: .direct, targetId: 8, title: "Боб Тестов")

    func testWriteFromACardOpenedOverTheSameChatGoesBack() {
        let router = NavigationRouter()
        router.push(.chat(bob))
        router.push(.person(PersonRoute(id: 8, name: "Боб Тестов")))
        router.open(chat: bob)
        XCTAssertEqual(router.path, [.chat(bob)])
    }

    func testWriteFromACardOpenedElsewherePushesTheChat() {
        let router = NavigationRouter()
        router.push(.person(PersonRoute(id: 8, name: "Боб Тестов")))
        router.open(chat: bob)
        XCTAssertEqual(router.path, [.person(PersonRoute(id: 8, name: "Боб Тестов")), .chat(bob)])
    }
}
