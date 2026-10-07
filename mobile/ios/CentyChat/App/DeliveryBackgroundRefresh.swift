import BackgroundTasks
import Foundation

/// The OS-level background flush of the outbox (`delivery-state.md` §4.2, parity with Android's
/// WorkManager flush): while messages or files wait, the app asks iOS for a background refresh;
/// when it runs, the queue goes out over HTTP (`DeliveryRuntime.flushInBackground`). iOS decides
/// when (at the earliest in 15 minutes); a silent push wakes the app sooner once push is on.
extension DeliveryBackgroundTask {
    /// The earliest a refresh is asked for.
    static let earliestDelay: TimeInterval = 15 * 60

    /// Registers the handler; must run before the app finishes launching.
    static func register() {
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            let job = BackgroundJob(task: task)
            let work = Task { @MainActor in
                let result = await PushRouter.shared.flushInBackground?() ?? .nothingToDo
                if result == .retryLater { schedule() }
                job.complete(success: result != .retryLater)
            }
            task.expirationHandler = {
                work.cancel()
                job.complete(success: false)
            }
        }
        if !registered {
            Log.delivery.error("The background flush could not be registered")
        }
    }

    /// Asks for a refresh while something waits to be sent.
    static func schedule(whenUnsent count: Int?) {
        guard (count ?? 1) > 0 else { return }
        schedule()
    }

    private static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: earliestDelay)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // The simulator and a user who turned Background App Refresh off say no: the queue then
            // goes out at the next launch, foreground or network change, as before.
            Log.delivery.notice("Background flush not scheduled: \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// Completes a background task once, from whichever side ends first (the work or the expiry).
private final class BackgroundJob: @unchecked Sendable {
    private let task: BGTask
    private let lock = NSLock()
    private var done = false

    init(task: BGTask) {
        self.task = task
    }

    func complete(success: Bool) {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { task.setTaskCompleted(success: success) }
    }
}
