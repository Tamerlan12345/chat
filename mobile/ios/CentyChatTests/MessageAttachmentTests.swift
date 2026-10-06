import Foundation
import XCTest
@testable import CentyChat

/// The file of a message and what its menu offers.
final class MessageAttachmentTests: XCTestCase {
    private func message(type: MessageType, text: String = "Акт.pdf", metadataJson: String? = nil, deleted: Bool = false, sender: Int64 = 2) -> Message {
        Message(id: 5, conversationType: .direct, targetId: 3, senderId: sender, text: text, type: type, metadataJson: metadataJson, isDeleted: deleted, senderName: "Алиса")
    }

    func testTheFileIsReadFromTheServersMetadata() {
        var file = message(type: .file, metadataJson: #"{"file_id":42,"size":2048,"mimeType":"application/pdf","url":"/api/files/download/42"}"#)
        file.fileOriginalName = "Договор.pdf"

        let attachment = MessageAttachment.of(file)

        XCTAssertEqual(attachment?.fileId, 42)
        XCTAssertEqual(attachment?.name, "Договор.pdf")
        XCTAssertEqual(attachment?.size, 2_048)
        XCTAssertEqual(attachment?.isImage, false)
    }

    func testAnImageCarriesItsSizeForThePlaceholder() {
        var image = message(type: .image, text: "фото.jpg", metadataJson: #"{"file_id":7,"mime_type":"image/jpeg","width":640,"height":480}"#)
        image.fileWidth = 1_280
        image.fileHeight = 960

        let attachment = MessageAttachment.of(image)

        XCTAssertEqual(attachment?.isImage, true)
        XCTAssertEqual(attachment?.width, 1_280, "the server's measured size wins over the sender's metadata")
        XCTAssertEqual(attachment?.height, 960)
    }

    func testATextOrADeletedMessageHasNoFile() {
        XCTAssertNil(MessageAttachment.of(message(type: .text)))
        XCTAssertNil(MessageAttachment.of(message(type: .file, metadataJson: #"{"file_id":1}"#, deleted: true)))
    }

    func testAFileOnItsWayIsDrawnFromTheLocalCopy() {
        var pending = message(type: .image, text: "Схема.png")
        pending.localUpload = LocalUpload(fileURL: URL(fileURLWithPath: "/tmp/k/Схема.png"), name: "Схема.png", size: 10, mimeType: "image/png", progress: 0.5)
        pending.pendingMetadata = ["file_id": 9]

        let attachment = MessageAttachment.of(pending)

        XCTAssertEqual(attachment?.localFile?.lastPathComponent, "Схема.png")
        XCTAssertEqual(attachment?.fileId, 9)
        XCTAssertEqual(attachment?.isImage, true)
    }

    func testTheMenuOfADeliveredOwnTextMessage() {
        let actions = MessageMenuPolicy.actions(for: message(type: .text, text: "Привет"), isOwn: true, canEdit: true, canDelete: true)
        XCTAssertEqual(actions, [.reply, .copy, .edit, .delete])
    }

    func testTheMenuOfSomeoneElsesMessage() {
        let actions = MessageMenuPolicy.actions(for: message(type: .text, text: "Привет", sender: 3), isOwn: false, canEdit: false, canDelete: false)
        XCTAssertEqual(actions, [.reply, .copy, .report, .blockSender])
    }

    func testAnUnsentMessageCanOnlyBeCopiedOrWithdrawn() {
        var queued = message(type: .text, text: "в очереди")
        queued.sendState = .queued
        XCTAssertEqual(MessageMenuPolicy.actions(for: queued, isOwn: true, canEdit: true, canDelete: true), [.copy, .delete])

        var failed = message(type: .text, text: "не дошло")
        failed.sendState = .failed
        XCTAssertEqual(MessageMenuPolicy.actions(for: failed, isOwn: true, canEdit: true, canDelete: false), [.copy, .retry, .delete])
    }

    func testAFileIsNeverEditedNorCopied() {
        let actions = MessageMenuPolicy.actions(for: message(type: .file, metadataJson: #"{"file_id":1}"#), isOwn: true, canEdit: true, canDelete: true)
        XCTAssertEqual(actions, [.reply, .delete])
    }

    func testADeletedMessageOffersNothing() {
        XCTAssertEqual(MessageMenuPolicy.actions(for: message(type: .text, deleted: true), isOwn: true, canEdit: true, canDelete: true), [])
    }
}
