import Foundation
import Network

/// Tells when the device gets a usable network path again (`NWPathMonitor`): the queue then goes
/// out without waiting for the socket's backoff.
@MainActor
final class NetworkPathWatcher {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "kz.centras.centychat.network-path")
    private var wasSatisfied: Bool?

    /// Whether the device has a usable path now; nil before the first answer.
    var isAvailable: Bool? { wasSatisfied }
    private var started = false
    /// Every change of the path (the connection banner's «Нет сети»).
    var onChange: (@MainActor (Bool) -> Void)?

    /// `onAvailable` runs on the main actor after each transition to a satisfied path.
    func start(onAvailable: @escaping @MainActor @Sendable () -> Void) {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                let previous = self.wasSatisfied
                self.wasSatisfied = satisfied
                if previous != satisfied { self.onChange?(satisfied) }
                if satisfied && previous == false { onAvailable() }
            }
        }
        monitor.start(queue: queue)
    }
}
