import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The type of a file extension (`UTType`), as a MIME type: what `AttachmentRules.openType` filters.
enum SystemFileTypes {
    static func mimeType(forExtension ext: String) -> String? {
        UTType(filenameExtension: ext)?.preferredMIMEType
    }
}

/// A full-screen image of a message: the thumbnail at once, the full picture once it has downloaded;
/// pinch or double-tap to zoom.
struct AttachmentImageViewer: View {
    let attachment: MessageAttachment
    let opener: AttachmentOpener
    let thumbnails: AttachmentThumbnails
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var thumbnail: UIImage?
    @State private var full: UIImage?
    @State private var scale: CGFloat = 1
    @State private var baseScale: CGFloat = 1

    private var transfer: AttachmentOpener.Transfer? {
        attachment.fileId.flatMap { opener.transfers[$0] }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let image = full ?? thumbnail {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .gesture(
                        MagnificationGesture()
                            .onChanged { value in scale = min(max(baseScale * value, 1), 5) }
                            .onEnded { _ in baseScale = scale }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                            scale = scale > 1 ? 1 : 2.5
                            baseScale = scale
                        }
                    }
                    .accessibilityLabel(Text(attachment.name))
                    .accessibilityAddTraits(.isImage)
            } else {
                ProgressView()
                    .tint(.white)
            }
        }
        .overlay(alignment: .top) {
            HStack {
                Text(attachment.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Spacer()
                Button("Закрыть") { dismiss() }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("image-viewer-close")
            }
            .padding(.horizontal, 16)
            .background(LinearGradient(colors: [.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom))
        }
        .overlay(alignment: .bottom) {
            switch transfer {
            case .running(let progress):
                ProgressView(value: progress ?? 0)
                    .tint(.white)
                    .padding(24)
                    .accessibilityLabel(Text("Загрузка фото"))
            case .failed(let reason):
                VStack(spacing: 8) {
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                    Button("Повторить") { opener.retry(attachment) }
                        .buttonStyle(.borderedProminent)
                        .frame(minHeight: 44)
                }
                .padding(24)
            default:
                EmptyView()
            }
        }
        // A container: its own identifier must not replace the close button's.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("image-viewer")
        .task {
            if let local = attachment.localFile {
                full = await Task.detached { UIImage(contentsOfFile: local.path) }.value
                return
            }
            if let id = attachment.fileId, let data = await thumbnails.data(for: id) {
                thumbnail = UIImage(data: data)
            }
        }
        .task(id: transfer) {
            if case .ready(let url)? = transfer {
                full = await Task.detached { UIImage(contentsOfFile: url.path) }.value
            }
        }
    }
}

/// Hands a file to other apps («Открыть в…», «Сохранить в Файлы»): the share sheet.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
