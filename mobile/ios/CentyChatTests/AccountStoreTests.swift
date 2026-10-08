import Foundation
import XCTest
@testable import CentyChat

/// Account deletion, reports and blocks through `AccountStore`.
@MainActor
final class AccountStoreTests: XCTestCase {
    private func makeStore(signedIn: Bool = true) async throws -> (store: AccountStore, app: TestApp, account: FakeAccountRepository) {
        let app = TestApp()
        await app.session.bootstrap()
        if signedIn {
            _ = try await app.session.login(username: "qa", password: "password")
        }
        let account = FakeAccountRepository()
        return (AccountStore(repository: account, session: app.session), app, account)
    }

    // MARK: - Deletion

    func testDeletingTheAccountSignsOutAndWipesLocalData() async throws {
        let (store, app, account) = try await makeStore()
        XCTAssertEqual(app.session.phase, .authenticated)
        XCTAssertTrue(app.auth.hasStoredToken)

        let failure = await store.deleteAccount(password: "Str0ng-Passw0rd")

        XCTAssertNil(failure)
        XCTAssertEqual(account.state.value.deletePasswords, ["Str0ng-Passw0rd"])
        XCTAssertEqual(app.session.phase, .signedOut)
        XCTAssertNil(app.session.currentUser)
        XCTAssertFalse(app.auth.hasStoredToken, "The stored session must be wiped")
        XCTAssertFalse(store.isDeleting)
        let disconnected = await app.realtime.isConnected
        XCTAssertFalse(disconnected, "The socket must be closed")
    }

    func testDeletingResetsTheOtherStores() async throws {
        let app = TestApp()
        await app.session.bootstrap()
        _ = try await app.session.login(username: "qa", password: "password")
        let account = app.container.account
        // The container's own store talks to the unavailable repository, so only reset is checked here.
        app.container.profile.incomingWakeAlert = "Вас вызывает: Коллега"

        await app.session.finishAccountDeletion()

        XCTAssertEqual(app.session.phase, .signedOut)
        XCTAssertNil(app.container.profile.incomingWakeAlert, "Local state must be wiped")
        XCTAssertTrue(account.blocked.isEmpty)
        XCTAssertTrue(app.container.conversations.directConversations.isEmpty)
    }

    func testWrongPasswordKeepsTheSession() async throws {
        let (store, app, account) = try await makeStore()
        account.state.withValue {
            $0.deleteError = APIError.httpError(statusCode: 403, message: "Неверный пароль", code: nil)
        }

        let failure = await store.deleteAccount(password: "wrong")

        XCTAssertEqual(failure, .wrongPassword)
        XCTAssertEqual(app.session.phase, .authenticated)
        XCTAssertTrue(app.auth.hasStoredToken)
    }

    func testLastAdministratorCannotDeleteTheAccount() async throws {
        let (store, app, account) = try await makeStore()
        account.state.withValue {
            $0.deleteError = APIError.httpError(statusCode: 400, message: "x", code: "LAST_ADMIN")
        }

        let failure = await store.deleteAccount(password: "Str0ng-Passw0rd")

        XCTAssertEqual(failure, .lastAdmin)
        XCTAssertEqual(app.session.phase, .authenticated)
    }

    func testOfflineDeletionKeepsTheSessionAndSaysSo() async throws {
        let (store, app, account) = try await makeStore()
        account.state.withValue { $0.deleteError = APIError.noConnection }

        let failure = await store.deleteAccount(password: "Str0ng-Passw0rd")

        XCTAssertEqual(failure, .offline)
        XCTAssertEqual(app.session.phase, .authenticated)
    }

    func testAnEmptyPasswordIsNotSent() async throws {
        let (store, _, account) = try await makeStore()

        let failure = await store.deleteAccount(password: "")

        XCTAssertEqual(failure, .wrongPassword)
        XCTAssertTrue(account.state.value.deletePasswords.isEmpty)
    }

    // MARK: - Blocks

    func testBlockAddsTheUserAndUnblockRemovesThem() async throws {
        let (store, _, account) = try await makeStore()

        let blockFailure = await store.block(userId: 12, name: "Данияр")

        XCTAssertNil(blockFailure)
        XCTAssertTrue(store.isBlocked(12))
        XCTAssertEqual(store.blockedIds, [12])
        XCTAssertEqual(account.state.value.blockedIds, [12])

        let unblockFailure = await store.unblock(userId: 12)

        XCTAssertNil(unblockFailure)
        XCTAssertFalse(store.isBlocked(12))
        XCTAssertEqual(account.state.value.unblockedIds, [12])
    }

    func testBlockingTwiceKeepsOneEntry() async throws {
        let (store, _, _) = try await makeStore()
        await store.block(userId: 12, name: "Данияр")
        await store.block(userId: 12, name: "Данияр")
        XCTAssertEqual(store.blocked.count, 1)
    }

    func testYouCannotBlockYourself() async throws {
        let (store, app, account) = try await makeStore()
        let myId = try XCTUnwrap(app.session.currentUser?.id)

        await store.block(userId: myId, name: "Я")

        XCTAssertFalse(store.isBlocked(myId))
        XCTAssertTrue(account.state.value.blockedIds.isEmpty)
    }

    func testFailedBlockLeavesTheListAlone() async throws {
        let (store, _, account) = try await makeStore()
        account.state.withValue { $0.blockError = APIError.noConnection }

        let failure = await store.block(userId: 12, name: "Данияр")

        XCTAssertEqual(failure, .offline)
        XCTAssertFalse(store.isBlocked(12))
        XCTAssertTrue(store.busyUserIds.isEmpty)
    }

    func testLoadingTheListReplacesItAndReportsFailures() async throws {
        let (store, _, account) = try await makeStore()
        account.state.withValue { $0.blockedList = .success([BlockedUser(id: 3, name: "Айгерим")]) }

        await store.loadBlocks()

        XCTAssertEqual(store.blocked.map(\.id), [3])
        XCTAssertEqual(store.blocksState, .loaded)

        account.state.withValue { $0.blockedList = .failure(APIError.noConnection) }
        await store.loadBlocks()

        XCTAssertEqual(store.blocked.map(\.id), [3], "A failed refresh keeps what is known")
        XCTAssertNotNil(store.blocksState.errorMessage)
    }

    func testSessionEndClearsTheBlockList() async throws {
        let (store, _, _) = try await makeStore()
        await store.block(userId: 12, name: "Данияр")

        store.reset()

        XCTAssertTrue(store.blocked.isEmpty)
        XCTAssertEqual(store.blocksState, .idle)
    }

    // MARK: - Reports

    func testReportSendsReasonAndTrimmedDetails() async throws {
        let (store, _, account) = try await makeStore()

        let failure = await store.report(targetType: .message, targetId: 42, reason: .abuse, details: "  грубит \n")

        XCTAssertNil(failure)
        XCTAssertEqual(
            account.state.value.reports,
            [ReportBody(targetType: .message, targetId: 42, reason: "abuse", details: "грубит")]
        )
    }

    func testReportWithBlankDetailsSendsNone() async throws {
        let (store, _, account) = try await makeStore()

        await store.report(targetType: .user, targetId: 9, reason: .spam, details: "   ")

        XCTAssertEqual(account.state.value.reports.first?.details, nil)
        XCTAssertEqual(account.state.value.reports.first?.targetType, .user)
    }

    func testReportDetailsAreCapped() async throws {
        let (store, _, account) = try await makeStore()

        await store.report(targetType: .message, targetId: 1, reason: .other, details: String(repeating: "я", count: 5_000))

        XCTAssertEqual(account.state.value.reports.first?.details?.count, 1_000)
    }

    func testFailedReportIsReportedToTheUser() async throws {
        let (store, _, account) = try await makeStore()
        account.state.withValue { $0.reportError = APIError.httpError(statusCode: 429, message: "x", code: nil, retryAfter: 20) }

        let failure = await store.report(targetType: .message, targetId: 1, reason: .spam, details: "")

        guard case .throttled = failure else { return XCTFail("Expected a throttling failure, got \(String(describing: failure))") }
    }

    func testEveryReasonHasARussianTitleAndAServerCode() {
        for reason in ReportReason.allCases {
            XCTAssertTrue(reason.title.unicodeScalars.contains { (0x0400...0x04FF).contains($0.value) }, reason.title)
            XCTAssertFalse(reason.rawValue.isEmpty)
        }
        XCTAssertEqual(Set(ReportReason.allCases.map(\.rawValue)).count, ReportReason.allCases.count)
    }

    // MARK: - Server waits (429)

    /// A 429 on a report or a block holds that action until the server's Retry-After is over
    /// (parity: Android's ReportController/BlockController); nothing is sent meanwhile.
    func testAThrottledReportIsHeldUntilTheServersWaitIsOver() async throws {
        let (_, app, account) = try await makeStore()
        let clock = Locked(Date(timeIntervalSince1970: 5_000))
        let store = AccountStore(repository: account, session: app.session, now: { clock.value })
        account.state.withValue { $0.reportError = APIError.httpError(statusCode: 429, message: "x", code: nil, retryAfter: 30) }

        _ = await store.report(targetType: .user, targetId: 3, reason: .spam, details: "")
        account.state.withValue { $0.reportError = nil }
        clock.withValue { $0 = $0.addingTimeInterval(10) }
        let held = await store.report(targetType: .user, targetId: 3, reason: .spam, details: "")

        XCTAssertEqual(held, .throttled(until: Date(timeIntervalSince1970: 5_030)))
        XCTAssertEqual(account.state.value.reports.count, 1, "nothing is sent during the wait")

        clock.withValue { $0 = $0.addingTimeInterval(21) }
        let sent = await store.report(targetType: .user, targetId: 3, reason: .spam, details: "")
        XCTAssertNil(sent)
        XCTAssertEqual(account.state.value.reports.count, 2)
    }

    func testAThrottledBlockIsHeldUntilTheServersWaitIsOver() async throws {
        let (_, app, account) = try await makeStore()
        let clock = Locked(Date(timeIntervalSince1970: 5_000))
        let store = AccountStore(repository: account, session: app.session, now: { clock.value })
        account.state.withValue { $0.blockError = APIError.httpError(statusCode: 429, message: "x", code: nil, retryAfter: 30) }

        _ = await store.block(userId: 3, name: "Боб Тестов")
        account.state.withValue { $0.blockError = nil }
        let held = await store.block(userId: 3, name: "Боб Тестов")

        XCTAssertEqual(held, .throttled(until: Date(timeIntervalSince1970: 5_030)))
        XCTAssertTrue(account.state.value.blockedIds.isEmpty)
        let heldUnblock = await store.unblock(userId: 4)
        XCTAssertEqual(heldUnblock, .throttled(until: Date(timeIntervalSince1970: 5_030)), "the server limits blocks and unblocks together")

        clock.withValue { $0 = $0.addingTimeInterval(31) }
        let blocked = await store.block(userId: 3, name: "Боб Тестов")
        XCTAssertNil(blocked)
        XCTAssertEqual(account.state.value.blockedIds, [3])
    }
}

