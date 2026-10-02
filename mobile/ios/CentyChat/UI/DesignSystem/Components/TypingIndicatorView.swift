import SwiftUI

/// Анимированный индикатор набора текста
public struct TypingIndicatorView: View {
    public let text: String
    @State private var phase: Int = 0
    
    public init(text: String = String(localized: "печатает...")) {
        self.text = text
    }
    
    public var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: 3) {
                ForEach(0..<3) { index in
                    Circle()
                        .fill(Color.secondary)
                        .frame(width: 5, height: 5)
                        .scaleEffect(phase == index ? 1.4 : 1.0)
                        .opacity(phase == index ? 1.0 : 0.4)
                }
            }
            .animation(.easeInOut(duration: 0.5).repeatForever(), value: phase)
            
            Text(text)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.5).repeatForever()) {
                phase = 2
            }
        }
    }
}
