package com.openmychat.mobile.features.attachments

import com.openmychat.mobile.testing.FakeAttachmentRepository
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** QA D4: a tap on a file downloads it (progress, failure on the tile) and opens it; an image opens in the viewer. */
@OptIn(ExperimentalCoroutinesApi::class)
class AttachmentOpenerTest {

    private val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher())
    private val files = FakeAttachmentRepository()
    private val notices = mutableListOf<String>()
    private val opener = AttachmentOpener(files, scope) { notices += it }
    private val opened = mutableListOf<OpenRequest>()

    init {
        scope.launch { opener.openRequests.collect { opened += it } }
    }

    @After
    fun tearDown() = scope.cancel()

    private val pdf = MessageAttachment(fileId = 42, name = "отчёт.pdf", size = 2048, mimeType = "application/pdf", isImage = false)
    private val photo = MessageAttachment(fileId = 43, name = "schema.png", size = 8000, mimeType = "image/png", isImage = true, width = 640, height = 480)

    @Test
    fun aFileDownloadsWithProgressAndThenOpens() {
        val gate = CompletableDeferred<File>()
        files.downloadGate = gate

        opener.open(pdf)

        assertEquals(TransferState.Running(null), opener.transfers.value[42])
        files.downloadProgress!!(0.25f)
        assertEquals(TransferState.Running(0.25f), opener.transfers.value[42])
        assertTrue("nothing opens before the file is here", opened.isEmpty())

        val file = File("отчёт.pdf")
        gate.complete(file)

        assertEquals(TransferState.Ready(file), opener.transfers.value[42])
        assertEquals(listOf(OpenRequest(file, "отчёт.pdf")), opened)
    }

    @Test
    fun aSecondTapWhileDownloadingDoesNotStartAnother() {
        files.downloadGate = CompletableDeferred()
        opener.open(pdf)
        opener.open(pdf)
        assertEquals(listOf(42L), files.downloads)
    }

    @Test
    fun aFailedDownloadShowsOnTheTileAndASecondTapRetries() {
        files.downloadFailure = AttachmentException("Нет связи с сервером — файл не скачан")

        opener.open(pdf)

        assertEquals(TransferState.Failed("Нет связи с сервером — файл не скачан"), opener.transfers.value[42])
        assertEquals(listOf("Нет связи с сервером — файл не скачан"), notices)
        assertTrue(opened.isEmpty())

        opener.open(pdf)

        assertEquals(2, files.downloads.size)
        assertEquals(1, opened.size)
    }

    @Test
    fun anImageOpensInTheViewerAndLoadsTheFullPictureThere() {
        opener.open(photo)

        assertEquals(photo, opener.viewer.value)
        assertEquals("the full image is fetched for the viewer", listOf(43L), files.downloads)
        assertTrue("no other app is asked to open a picture", opened.isEmpty())
        assertEquals(TransferState.Ready(File("schema.png")), opener.transfers.value[43])

        opener.closeViewer()
        assertNull(opener.viewer.value)
    }

    @Test
    fun aFailedFullImageStaysInTheViewerWithoutASnackbar() {
        files.downloadFailure = AttachmentException("Файл не найден")
        opener.open(photo)
        assertEquals(TransferState.Failed("Файл не найден"), opener.transfers.value[43])
        assertTrue("the viewer says it itself", notices.isEmpty())

        opener.retry(photo)
        assertEquals(TransferState.Ready(File("schema.png")), opener.transfers.value[43])
    }

    @Test
    fun aFileNotYetUploadedCannotBeOpened() {
        opener.open(pdf.copy(fileId = null, localUri = "content://docs/1"))
        assertTrue(files.downloads.isEmpty())
        assertNull(opener.viewer.value)
    }

    @Test
    fun anUnexpectedFailureStillGetsARussianReason() {
        files.downloadFailure = IllegalStateException("boom")
        opener.open(pdf)
        assertEquals(TransferState.Failed("Не удалось скачать файл"), opener.transfers.value[42])
    }

    @Test
    fun theThumbnailComesFromTheConfiguredServer() {
        assertEquals("https://chat.example.com/api/files/thumb/43?size=m", opener.thumbnailUrl(photo))
        assertNull(opener.thumbnailUrl(photo.copy(fileId = null)))
    }
}
