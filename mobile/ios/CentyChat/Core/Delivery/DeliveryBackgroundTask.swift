import Foundation

/// The OS-level background flush of the outbox (`delivery-state.md` §4.2).
enum DeliveryBackgroundTask {
    /// Listed in `BGTaskSchedulerPermittedIdentifiers`.
    static let identifier = "kz.centras.centychat.delivery-flush"
}
