import Foundation
import Observation

/// Account deletion, reports and the block list of the signed-in user.
@Observable
@MainActor
public final class AccountStore {
    public private(set) var blocked: [BlockedUser] = []
    public private(set) var blocksState: LoadState = .idle
    /// User ids with a block/unblock request in flight.
    public private(set) var busyUserIds: Set<Int64> = []
    public private(set) var isDeleting = false

    @ObservationIgnored private let repository: any AccountRepository
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private let now: @MainActor () -> Date
    /// Runs after a block or unblock went through: the server now hides or shows that person's
    /// direct messages, so lists and open chats are reloaded.
    @ObservationIgnored var onBlocksChanged: (@MainActor () async -> Void)?

    init(
        repository: any AccountRepository,
        session: SessionStore,
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.repository = repository
        self.session = session
        self.now = now
    }

    public var blockedIds: Set<Int64> { Set(blocked.map(\.id)) }

    public func isBlocked(_ userId: Int64) -> Bool {
        blocked.contains { $0.id == userId }
    }

    // MARK: - Blocks

    public func loadBlocks() async {
        blocksState = .loading
        do {
            blocked = try await repository.blockedUsers()
            blocksState = .loaded
        } catch {
            Log.session.error("Loading the block list failed: \(error.localizedDescription, privacy: .public)")
            blocksState = .failed(AccountFailure(error, context: .generic, now: now()).message(at: now()) ?? "")
        }
    }

    /// Blocks `userId`. Returns nil on success, otherwise what to tell the user.
    @discardableResult
    public func block(userId: Int64, name: String) async -> AccountFailure? {
        guard session.currentUser?.id != userId, !busyUserIds.contains(userId) else { return nil }
        busyUserIds.insert(userId)
        defer { busyUserIds.remove(userId) }
        do {
            try await repository.blockUser(id: userId)
            if !isBlocked(userId) {
                blocked.append(BlockedUser(id: userId, name: name))
            }
            await onBlocksChanged?()
            return nil
        } catch {
            return AccountFailure(error, context: .generic, now: now())
        }
    }

    @discardableResult
    public func unblock(userId: Int64) async -> AccountFailure? {
        guard !busyUserIds.contains(userId) else { return nil }
        busyUserIds.insert(userId)
        defer { busyUserIds.remove(userId) }
        do {
            try await repository.unblockUser(id: userId)
            blocked.removeAll { $0.id == userId }
            await onBlocksChanged?()
            return nil
        } catch {
            return AccountFailure(error, context: .generic, now: now())
        }
    }

    // MARK: - Reports

    @discardableResult
    public func report(
        targetType: ReportTargetType,
        targetId: Int64,
        reason: ReportReason,
        details: String
    ) async -> AccountFailure? {
        let trimmed = details.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = ReportBody(
            targetType: targetType,
            targetId: targetId,
            reason: reason.rawValue,
            details: trimmed.isEmpty ? nil : String(trimmed.prefix(1000))
        )
        do {
            try await repository.report(body)
            return nil
        } catch {
            return AccountFailure(error, context: .generic, now: now())
        }
    }

    // MARK: - Deletion

    /// Deletes the account on the server (the password is re-checked there), then signs out and
    /// wipes everything stored on this device. A failure leaves the session untouched.
    @discardableResult
    public func deleteAccount(password: String) async -> AccountFailure? {
        guard !isDeleting else { return nil }
        guard !password.isEmpty else { return .wrongPassword }
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await repository.deleteAccount(password: password)
        } catch {
            return AccountFailure(error, context: .deleteAccount, now: now())
        }
        await session.finishAccountDeletion()
        return nil
    }

    func reset() {
        blocked = []
        blocksState = .idle
        busyUserIds = []
        isDeleting = false
    }
}
