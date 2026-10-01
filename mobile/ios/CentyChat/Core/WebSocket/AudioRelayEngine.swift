import Foundation

/// Аудио-движок бинарного релея звука CentyChat поверх WebSocket
/// Спецификация ws-protocol.md Section 5:
/// - Размер кадра: ровно 1028 байт (4 байта UInt32BE + 1024 байта PCM Int16BE).
/// - 512 сэмплов по 16 бит моно на 16 000 Гц = 32 мс на кадр.
/// - Отсечение тишины: SILENCE_THRESHOLD = 0.0015.
public final class AudioRelayEngine: @unchecked Sendable {
    public static let sampleRate: Double = 16_000.0
    public static let samplesPerFrame: Int = 512
    public static let frameSizeBytes: Int = 1_028
    public static let pcmSizeBytes: Int = 1_024
    public static let silenceThreshold: Float = 0.0015
    
    public init() {}
    
    // MARK: - Encoding (Float32 Samples -> 1028-byte Binary Frame)
    
    /// Кодирует 512 сэмплов Float32 в 1028-байтный бинарный кадр с отсечением тишины
    /// - Parameters:
    ///   - samples: Массив сэмплов Float32 в диапазоне [-1.0 ... 1.0]
    ///   - targetUserId: ID собеседника (UInt32BE)
    /// - Returns: Двоичный кадр Data размером 1028 байт, либо nil при тишине или некорректном размере
    public static func encodeFrame(samples: [Float], targetUserId: Int64) -> Data? {
        guard samples.count == samplesPerFrame else { return nil }
        
        // 1. Детекция тишины (Silence Gating)
        var sumAbs: Float = 0.0
        for s in samples {
            sumAbs += abs(s)
        }
        let avgAmplitude = sumAbs / Float(samplesPerFrame)
        if avgAmplitude < silenceThreshold {
            // Тишина — отбрасываем кадр для экономии трафика и батареи
            return nil
        }
        
        // 2. Формирование 1028-байтного фрейма
        var data = Data(capacity: frameSizeBytes)
        
        // 4 байта targetUserId (UInt32 Big-Endian)
        var beTargetId = UInt32(targetUserId).bigEndian
        data.append(UnsafeBufferPointer(start: &beTargetId, count: 1))
        
        // 1024 байта PCM: 512 сэмплов Int16 Big-Endian
        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            let int16Val = Int16(clamped * 32767.0)
            var beSample = int16Val.bigEndian
            data.append(UnsafeBufferPointer(start: &beSample, count: 1))
        }
        
        return data
    }
    
    // MARK: - Decoding (1028-byte Binary Frame -> SenderId + Float32 Samples)
    
    public struct DecodedAudioFrame: Sendable {
        public let senderId: Int64
        public let samples: [Float]
    }
    
    /// Декодирует 1028-байтный входящий кадр из WebSocket в ID отправителя и массив Float32
    public static func decodeFrame(data: Data) -> DecodedAudioFrame? {
        guard data.count == frameSizeBytes else { return nil }
        
        // Чтение первых 4 байт (UInt32 Big-Endian)
        let senderIdRaw = data.subdata(in: 0..<4).withUnsafeBytes { ptr -> UInt32 in
            ptr.load(as: UInt32.self).bigEndian
        }
        let senderId = Int64(senderIdRaw)
        
        // Чтение 512 сэмплов Int16 Big-Endian и нормализация в Float [-1.0 ... 1.0]
        var samples = [Float](repeating: 0.0, count: samplesPerFrame)
        data.subdata(in: 4..<frameSizeBytes).withUnsafeBytes { ptr in
            let int16Buffer = ptr.bindMemory(to: Int16.self)
            for i in 0..<samplesPerFrame {
                let beSample = int16Buffer[i].bigEndian
                samples[i] = Float(beSample) / 32768.0
            }
        }
        
        return DecodedAudioFrame(senderId: senderId, samples: samples)
    }
}
