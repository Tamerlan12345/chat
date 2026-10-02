import Foundation
import Observation

/// Corporate announcements and acknowledgements.
@Observable
@MainActor
public final class AnnouncementsStore: RealtimeEventHandling {
    public var announcements: [Announcement] = []

    @ObservationIgnored private let repository: any AnnouncementsRepository
    @ObservationIgnored private let session: SessionStore

    init(repository: any AnnouncementsRepository, session: SessionStore) {
        self.repository = repository
        self.session = session
    }

    public var unconfirmedCount: Int {
        announcements.filter { !$0.isConfirmed }.count
    }

    /// Returns true when the server confirmed the acknowledgement.
    public func acknowledge(id: Int64) async -> Bool {
        do {
            let response = try await repository.acknowledge(id: id)
            guard response.success else { return false }
            markConfirmed(id: id)
            return true
        } catch {
            Log.announcements.error("Acknowledge failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func reset() {
        announcements = []
    }

    private func markConfirmed(id: Int64) {
        if let index = announcements.firstIndex(where: { $0.id == id }) {
            announcements[index].isConfirmed = true
            announcements[index].confirmedAt = Date()
        }
    }

    // MARK: - Realtime

    func handle(_ event: WSServerEvent) {
        switch event {
        case .newAnnouncement(let announcement):
            if !announcements.contains(where: { $0.id == announcement.id }) {
                announcements.insert(announcement, at: 0)
                CentyHaptics.warning()
            }

        case .announcementAcknowledged(let announcementId, let userId, _):
            if let id = Int64(announcementId), userId == session.currentUser?.id {
                markConfirmed(id: id)
            }

        default:
            break
        }
    }
}
