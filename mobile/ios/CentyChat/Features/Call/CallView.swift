import SwiftUI

/// Полноэкранный интерфейс голосового вызова CentyChat в стиле Apple HIG
public struct CallView: View {
    @Environment(AppState.self) private var appState
    
    public init() {}
    
    public var body: some View {
        guard let call = appState.activeCall else {
            return AnyView(EmptyView())
        }
        
        return AnyView(
            ZStack {
                // Фон: темный градиент с эффектом размытия
                LinearGradient(
                    colors: [Color.black.opacity(0.92), Color(red: 0.05, green: 0.10, blue: 0.20)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()
                
                VStack(spacing: 40) {
                    Spacer()
                    
                    // Аватар и имя собеседника
                    VStack(spacing: 16) {
                        AvatarView(
                            name: call.peerName,
                            avatarUrl: call.peerAvatar,
                            size: 110
                        )
                        .overlay(
                            Circle()
                                .stroke(Color.white.opacity(0.2), lineWidth: 3)
                        )
                        .shadow(color: .black.opacity(0.3), radius: 10, x: 0, y: 5)
                        
                        Text(call.peerName)
                            .font(.system(size: 26, weight: .bold))
                            .foregroundColor(.white)
                        
                        // Статус или таймер вызова
                        if call.state == .active {
                            Text(call.formattedDuration)
                                .font(.system(size: 20, weight: .medium, design: .monospaced))
                                .foregroundColor(.white.opacity(0.85))
                        } else {
                            Text(call.state.descriptionRu)
                                .font(.system(size: 18, weight: .regular))
                                .foregroundColor(.white.opacity(0.7))
                        }
                    }
                    
                    Spacer()
                    
                    // Панель управления звонком
                    if call.state == .ringing && call.direction == .incoming {
                        incomingCallControls(call)
                    } else {
                        activeOrOutgoingCallControls(call)
                    }
                }
                .padding(.bottom, 60)
            }
        )
    }
    
    // MARK: - Incoming Call Controls (Answer / Reject)
    
    private func incomingCallControls(_ call: CallSession) -> some View {
        HStack(spacing: 60) {
            // Кнопка отклонить
            Button(action: {
                Task { await appState.rejectIncomingCall() }
            }) {
                VStack(spacing: 8) {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 30))
                        .foregroundColor(.white)
                        .frame(width: 72, height: 72)
                        .background(CentyColors.centrasRed)
                        .clipShape(Circle())
                    Text("Отклонить")
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.8))
                }
            }
            
            // Кнопка принять
            Button(action: {
                Task { await appState.answerIncomingCall() }
            }) {
                VStack(spacing: 8) {
                    Image(systemName: "phone.fill")
                        .font(.system(size: 30))
                        .foregroundColor(.white)
                        .frame(width: 72, height: 72)
                        .background(CentyColors.statusOnline)
                        .clipShape(Circle())
                    Text("Принять")
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.8))
                }
            }
        }
    }
    
    // MARK: - Active / Outgoing Controls
    
    private func activeOrOutgoingCallControls(_ call: CallSession) -> some View {
        VStack(spacing: 36) {
            // Микрофон и громкая связь
            HStack(spacing: 48) {
                // Mute
                Button(action: {
                    appState.toggleMute()
                }) {
                    VStack(spacing: 6) {
                        Image(systemName: call.isMuted ? "mic.slash.fill" : "mic.fill")
                            .font(.system(size: 24))
                            .foregroundColor(call.isMuted ? .black : .white)
                            .frame(width: 60, height: 60)
                            .background(call.isMuted ? Color.white : Color.white.opacity(0.18))
                            .clipShape(Circle())
                        Text(call.isMuted ? "Вкл. микрофон" : "Без звука")
                            .font(.caption2)
                            .foregroundColor(.white.opacity(0.75))
                    }
                }
                
                // Speaker
                Button(action: {
                    appState.toggleSpeaker()
                }) {
                    VStack(spacing: 6) {
                        Image(systemName: call.isSpeakerOn ? "speaker.wave.3.fill" : "speaker.fill")
                            .font(.system(size: 24))
                            .foregroundColor(call.isSpeakerOn ? .black : .white)
                            .frame(width: 60, height: 60)
                            .background(call.isSpeakerOn ? Color.white : Color.white.opacity(0.18))
                            .clipShape(Circle())
                        Text(call.isSpeakerOn ? "Динамик" : "Динамик")
                            .font(.caption2)
                            .foregroundColor(.white.opacity(0.75))
                    }
                }
            }
            
            // Завершить вызов
            Button(action: {
                Task { await appState.endCall() }
            }) {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 32))
                    .foregroundColor(.white)
                    .frame(width: 72, height: 72)
                    .background(CentyColors.centrasRed)
                    .clipShape(Circle())
            }
        }
    }
}
