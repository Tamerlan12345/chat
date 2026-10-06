import UIKit

/// Decoded avatar photos on the main actor.
@MainActor
final class AvatarImageMemo {
    func image(for key: String) -> UIImage? {
        nil
    }

    func store(_ image: UIImage, for key: String) {}

    func inlineImage(_ dataURL: String) -> UIImage? {
        nil
    }

    func removeAll() {}
}
