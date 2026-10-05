package com.openmychat.mobile.features.attachments

import com.openmychat.mobile.testing.FakeAttachmentRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The type another app is asked to open a file as never comes from the sender (audit R4-14): it is
 * the extension's type (extensions are the admin's policy), kept only if the server's own
 * `safeDownloadType` allowlist has it, else `application/octet-stream`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AttachmentIntentsTest {

    /** What `MimeTypeMap` answers on a device, for the extensions used here. */
    private val system = mapOf(
        "pdf" to "application/pdf", "txt" to "text/plain", "csv" to "text/csv", "png" to "image/png",
        "jpg" to "image/jpeg", "svg" to "image/svg+xml", "html" to "text/html", "htm" to "text/html",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "mp4" to "video/mp4", "zip" to "application/zip", "xml" to "text/xml", "js" to "application/javascript"
    )

    private fun type(name: String) = AttachmentIntents.viewType(name) { system[it] }

    @Test
    fun aTxtLabelledTextHtmlBySenderOpensAsPlainText() {
        val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher())
        val opener = AttachmentOpener(FakeAttachmentRepository(), scope) {}
        val requests = mutableListOf<OpenRequest>()
        scope.launch { opener.openRequests.collect { requests += it } }

        opener.open(MessageAttachment(fileId = 7, name = "notes.txt", size = 10, mimeType = "text/html", isImage = false))

        val request = requests.single()
        assertEquals("the sender's label does not travel to the intent", OpenRequest(File("notes.txt"), "notes.txt"), request)
        assertEquals("text/plain", AttachmentIntents.viewType(request.name) { system[it] })
        scope.cancel()
    }

    @Test
    fun typesOnTheServersAllowlistOpenAsThemselves() {
        assertEquals("application/pdf", type("Протокол.PDF"))
        assertEquals("text/plain", type("a.txt"))
        assertEquals("text/csv", type("a.csv"))
        assertEquals("image/png", type("a.png"))
        assertEquals("image/jpeg", type("a.jpg"))
        assertEquals("video/mp4", type("a.mp4"))
        assertEquals("application/zip", type("a.zip"))
    }

    @Test
    fun scriptableTypesAreNeverHandedOut() {
        assertEquals("application/octet-stream", type("logo.svg"))
        assertEquals("application/octet-stream", type("page.html"))
        assertEquals("application/octet-stream", type("page.htm"))
        assertEquals("application/octet-stream", type("feed.xml"))
        assertEquals("application/octet-stream", type("app.js"))
    }

    @Test
    fun typesOutsideTheAllowlistOrUnknownAreOctetStream() {
        assertEquals("application/octet-stream", type("report.docx"))
        assertEquals("application/octet-stream", type("README"))
        assertEquals("application/octet-stream", type("x.unknownext"))
    }

    @Test
    fun theAllowlistMirrorsTheServer() {
        assertEquals(
            setOf(
                "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
                "application/pdf", "text/plain", "text/csv",
                "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/webm",
                "video/mp4", "video/webm", "video/quicktime",
                "application/zip", "application/x-7z-compressed", "application/vnd.rar", "application/x-rar-compressed"
            ),
            AttachmentIntents.SAFE_TYPES
        )
    }
}
