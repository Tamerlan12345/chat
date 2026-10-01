import Foundation

/// Буфер компенсации джиттера (Jitter Scheduler) для аудио-релея CentyChat
/// Реализует требования ws-protocol.md Section 5.4:
/// - Целевое опережение (TARGET_LEAD_SECONDS): 60 мс (0.06 с).
/// - Потолок джиттер-буфера (MAX_LEAD_SECONDS): 250 мс (0.25 с).
/// - При превышении 250 мс очередь сбрасывается к 60 мс во избежание растущей задержки.
public final class JitterScheduler: @unchecked Sendable {
    public static let targetLeadSeconds: TimeInterval = 0.06   // 60 мс
    public static let maxLeadSeconds: TimeInterval = 0.25      // 250 мс
    public static let frameDurationSeconds: TimeInterval = 0.032 // 32 мс (512 сэмплов / 16000 Гц)
    
    private let lock = NSLock()
    private var nextPlayTime: TimeInterval = 0
    private var isPlaying = false
    
    public init() {}
    
    /// Сброс состояния планировщика при начале или завершении вызова
    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        nextPlayTime = 0
        isPlaying = false
    }
    
    /// Планирует время воспроизведения входящего кадра
    /// - Parameter currentTime: Текущее системное время в секундах
    /// - Returns: Запланированное время воспроизведения кадра
    public func scheduleFrame(currentTime: TimeInterval) -> TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        
        if !isPlaying || nextPlayTime < currentTime {
            // Первый кадр или буфер опустел — начинаем с целевого опережения 60 мс
            nextPlayTime = currentTime + Self.targetLeadSeconds
            isPlaying = true
        } else if (nextPlayTime - currentTime) > Self.maxLeadSeconds {
            // Буфер переполнился (> 250 мс) — сбрасываем к 60 мс во избежание отставания
            nextPlayTime = currentTime + Self.targetLeadSeconds
        }
        
        let scheduled = nextPlayTime
        nextPlayTime += Self.frameDurationSeconds
        return scheduled
    }
}
