package com.openmychat.mobile.features.attachments

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream

/**
 * Downloads go to the app cache and resume (openapi.yaml `/files/download/{id}`): `Range` +
 * `If-Range` with the stored ETag continue a broken download (206), a changed file starts over (200),
 * a stale range (416) starts over, and a cached copy is revalidated with `If-None-Match` (304).
 */
class AttachmentDownloaderTest {

    @get:Rule val tmp = TemporaryFolder()

    private val content = ByteArray(10_000) { (it % 251).toByte() }
    private val etag = "\"abc123\""

    private data class Call(val fileId: Long, val rangeFrom: Long?, val ifRange: String?, val ifNoneMatch: String?)

    private class FakeTransport : DownloadTransport {
        val calls = mutableListOf<Call>()
        val answers = ArrayDeque<(Call) -> DownloadResponse>()
        override fun get(fileId: Long, rangeFrom: Long?, ifRange: String?, ifNoneMatch: String?): DownloadResponse {
            val call = Call(fileId, rangeFrom, ifRange, ifNoneMatch)
            calls += call
            return answers.removeFirst()(call)
        }
    }

    private val transport = FakeTransport()
    private val downloader by lazy { AttachmentDownloader(tmp.root, transport) }

    private fun full(bytes: ByteArray = content, tag: String? = etag, body: InputStream = ByteArrayInputStream(bytes)) =
        DownloadResponse(code = 200, etag = tag, contentLength = bytes.size.toLong(), contentRange = null, body = body)

    /** A body that breaks after [limit] bytes, like a dropped connection. */
    private fun breaking(bytes: ByteArray, limit: Int): InputStream = object : InputStream() {
        private var position = 0
        override fun read(): Int {
            if (position >= limit) throw IOException("connection reset")
            return bytes[position++].toInt() and 0xff
        }
    }

    @Test
    fun aFreshDownloadLandsInTheCacheUnderItsOwnName() {
        transport.answers += { full() }
        val progress = mutableListOf<Float?>()

        val file = downloader.fetch(42, "отчёт.pdf", onProgress = { progress += it })

        assertEquals("отчёт.pdf", file.name)
        assertTrue("inside the cache root", file.canonicalPath.startsWith(tmp.root.canonicalPath))
        assertArrayEquals(content, file.readBytes())
        assertEquals(Call(42, null, null, null), transport.calls.single())
        assertEquals(1f, progress.last())
    }

    @Test
    fun aBrokenDownloadKeepsWhatArrivedAndResumesWithRangeAndIfRange() {
        transport.answers += { full(body = breaking(content, 4_000)) }
        try {
            downloader.fetch(42, "big.zip")
            fail("a dropped connection must fail")
        } catch (e: AttachmentException) {
            assertEquals("Связь прервалась — нажмите ещё раз, загрузка продолжится", e.message)
        }

        transport.answers += { call ->
            val from = call.rangeFrom!!.toInt()
            DownloadResponse(
                code = 206, etag = etag, contentLength = (content.size - from).toLong(),
                contentRange = "bytes $from-${content.size - 1}/${content.size}",
                body = ByteArrayInputStream(content.copyOfRange(from, content.size))
            )
        }
        val file = downloader.fetch(42, "big.zip")

        assertEquals(Call(42, 4_000, etag, null), transport.calls.last())
        assertArrayEquals(content, file.readBytes())
    }

    @Test
    fun aFileThatChangedSinceThePartialStartsOverWhenTheServerSendsItWhole() {
        transport.answers += { full(body = breaking(content, 3_000)) }
        runCatching { downloader.fetch(42, "big.zip") }

        val changed = ByteArray(5_000) { 7 }
        transport.answers += { full(bytes = changed, tag = "\"new\"") }
        val file = downloader.fetch(42, "big.zip")

        assertArrayEquals("the partial is not glued to the new file", changed, file.readBytes())
    }

    @Test
    fun aRefusedRangeDropsThePartialAndDownloadsAgain() {
        transport.answers += { full(body = breaking(content, 3_000)) }
        runCatching { downloader.fetch(42, "big.zip") }

        transport.answers += { DownloadResponse(code = 416, etag = null, contentLength = 0, contentRange = "bytes */10000", body = null) }
        transport.answers += { full() }
        val file = downloader.fetch(42, "big.zip")

        assertEquals("the retry is a plain request", Call(42, null, null, null), transport.calls.last())
        assertArrayEquals(content, file.readBytes())
    }

    @Test
    fun aCachedFileIsRevalidatedAndReusedOnNotModified() {
        transport.answers += { full() }
        val first = downloader.fetch(42, "отчёт.pdf")

        transport.answers += { DownloadResponse(code = 304, etag = etag, contentLength = null, contentRange = null, body = null) }
        val second = downloader.fetch(42, "отчёт.pdf")

        assertEquals(Call(42, null, null, etag), transport.calls.last())
        assertEquals(first, second)
        assertArrayEquals(content, second.readBytes())
    }

    @Test
    fun aCachedFileOpensOfflineWhenTheServerCannotBeReached() {
        transport.answers += { full() }
        downloader.fetch(42, "отчёт.pdf")

        transport.answers += { throw IOException("offline") }
        assertArrayEquals(content, downloader.fetch(42, "отчёт.pdf").readBytes())
    }

    @Test
    fun withoutACopyAndWithoutANetworkTheReasonIsInRussian() {
        transport.answers += { throw IOException("offline") }
        try {
            downloader.fetch(42, "отчёт.pdf")
            fail()
        } catch (e: AttachmentException) {
            assertEquals("Нет связи с сервером — файл не скачан", e.message)
        }
    }

    @Test
    fun theServersRefusalIsShownAsItSaysAndACachedCopyIsDropped() {
        transport.answers += { full() }
        val cached = downloader.fetch(42, "отчёт.pdf")

        transport.answers += {
            DownloadResponse(code = 403, etag = null, contentLength = null, contentRange = null, body = null,
                errorText = "Доступ запрещен: файл вне ваших диалогов и каналов")
        }
        try {
            downloader.fetch(42, "отчёт.pdf")
            fail()
        } catch (e: AttachmentException) {
            assertEquals("Доступ запрещен: файл вне ваших диалогов и каналов", e.message)
        }
        assertFalse("no access, no copy", cached.exists())
    }

    @Test
    fun aJsonRefusalIsReadForItsErrorText() {
        transport.answers += {
            DownloadResponse(code = 404, etag = null, contentLength = null, contentRange = null, body = null,
                errorText = """{"error":"Файл не найден"}""")
        }
        try {
            downloader.fetch(42, "x.pdf")
            fail()
        } catch (e: AttachmentException) {
            assertEquals("Файл не найден", e.message)
        }
    }

    @Test
    fun aShortBodyIsNotPassedOffAsTheFile() {
        val short = content.copyOfRange(0, 6_000)
        transport.answers += {
            DownloadResponse(code = 200, etag = etag, contentLength = content.size.toLong(), contentRange = null, body = ByteArrayInputStream(short))
        }
        try {
            downloader.fetch(42, "big.zip")
            fail()
        } catch (e: AttachmentException) {
            assertEquals("Связь прервалась — нажмите ещё раз, загрузка продолжится", e.message)
        }
        assertNull("nothing under the final name", File(tmp.root, "42").listFiles()?.firstOrNull { it.name == "big.zip" })
    }

    @Test
    fun namesCannotEscapeTheCacheOrHideAsDotFiles() {
        assertEquals("_.._evil.pdf", AttachmentDownloader.safeName("/../evil.pdf"))
        assertEquals("a_b_c.txt", AttachmentDownloader.safeName("a\\b:c.txt"))
        assertEquals("файл", AttachmentDownloader.safeName("   "))
        assertEquals("_.part", AttachmentDownloader.safeName(".part"))
        assertTrue(AttachmentDownloader.safeName("x".repeat(500) + ".pdf").let { it.length <= 120 && it.endsWith(".pdf") })
    }
}
