import Foundation

actor TokenRefreshCoordinator {
    private var inFlight: (staleToken: String, id: UUID, task: Task<String, Error>)?

    func token(
        for staleToken: String,
        operation: @escaping @Sendable () async throws -> String
    ) async throws -> String {
        let task: Task<String, Error>
        let taskID: UUID
        if let inFlight, inFlight.staleToken == staleToken {
            task = inFlight.task
            taskID = inFlight.id
        } else {
            let newTask = Task(priority: nil, operation: operation)
            let newTaskID = UUID()
            inFlight = (staleToken, newTaskID, newTask)
            task = newTask
            taskID = newTaskID
        }

        do {
            let refreshedToken = try await task.value
            clearInFlightTask(for: staleToken, matching: taskID)
            return refreshedToken
        } catch {
            clearInFlightTask(for: staleToken, matching: taskID)
            throw error
        }
    }

    private func clearInFlightTask(for staleToken: String, matching taskID: UUID) {
        guard let inFlight,
              inFlight.staleToken == staleToken,
              inFlight.id == taskID else {
            return
        }
        self.inFlight = nil
    }
}
