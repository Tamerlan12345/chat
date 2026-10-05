package com.openmychat.mobile.core.network

import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File

/** `POST /api/files/upload` (multipart, field `file`) and `GET /api/files/download/{id}` with Range. */
class FileTransferClientTest {

    private val base = "https://chat.example.com/api"
    private val requests = mutableListOf<Request>()
    private val bodies = mutableListOf<ByteArray>()
    private var answer: (Request) -> Response = { error("no answer") }

    private val http = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val request = chain.request()
            requests += request
            request.body?.let { body -> bodies += Buffer().also { body.writeTo(it) }.readByteArray() }
            answer(request)
        }
        .build()

    private val failures = mutableListOf<Int>()
    private val client = FileTransferClient(http, { base }) { code, body, _ ->
        failures += code
        val text = Regex("\"error\":\"([^\"]*)\"").find(body)?.groupValues?.get(1) ?: "HTTP error $code"
        throw ApiException(code, null, text)
    }

    private fun respond(request: Request, code: Int, body: String, vararg headers: Pair<String, String>): Response =
        Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("x")
            .apply { headers.forEach { header(it.first, it.second) } }
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()

    private fun fixture(name: String): String {
        val start = File(requireNotNull(System.getProperty("user.dir")))
        return generateSequence(start) { it.parentFile }
            .map { File(it, "mobile/contracts/fixtures/http/$name").takeIf(File::isFile) ?: File(it, "contracts/fixtures/http/$name") }
            .first { it.isFile }
            .readText()
    }

    @Test
    fun aFileGoesUpAsTheMultipartFieldFileWithItsNameAndProgress() = runTest {
        answer = { respond(it, 201, fixture("files.upload.json")) }
        val content = "Протокол встречи 05.10".toByteArray()
        val progress = mutableListOf<Pair<Long, Long?>>()

        val uploaded = client.upload("протокол.txt", "text/plain", content.size.toLong(), { ByteArrayInputStream(content) }) { sent, total ->
            progress += sent to total
        }

        assertEquals("2", uploaded.id)
        val request = requests.single()
        assertEquals("POST", request.method)
        assertEquals("$base/files/upload", request.url.toString())
        val body = bodies.single()
        val text = String(body, Charsets.UTF_8)
        assertTrue(text, text.contains("Content-Disposition: form-data; name=\"file\"; filename=\"протокол.txt\""))
        assertTrue(text.contains("Content-Type: text/plain"))
        assertTrue("the bytes travel as they are", String(body, Charsets.UTF_8).contains("Протокол встречи 05.10"))
        assertEquals(content.size.toLong() to content.size.toLong(), progress.last())
    }

    @Test
    fun aPolicyRefusalComesBackWithTheServersRussianText() = runTest {
        answer = { respond(it, 415, """{"error":"Файлы .exe к отправке не разрешены","code":"ext-not-allowed"}""") }
        try {
            client.upload("setup.exe", null, 3, { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }) { _, _ -> }
            fail("415 must fail")
        } catch (e: ApiException) {
            assertEquals(415, e.statusCode)
            assertEquals("Файлы .exe к отправке не разрешены", e.message)
        }
        assertEquals(listOf(415), failures)
    }

    @Test
    fun anOversizedFileIsRefusedWithTheServersText() = runTest {
        answer = { respond(it, 413, """{"error":"Файл больше 20 МБ — такой файл загрузить нельзя"}""") }
        try {
            client.upload("big.pdf", "application/pdf", 3, { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }) { _, _ -> }
            fail()
        } catch (e: ApiException) {
            assertEquals("Файл больше 20 МБ — такой файл загрузить нельзя", e.message)
        }
    }

    @Test
    fun aDownloadAsksForTheRestWithRangeAndIfRange() {
        answer = {
            respond(it, 206, "rest", "ETag" to "\"abc\"", "Content-Range" to "bytes 6-9/10")
        }
        client.get(42, rangeFrom = 6, ifRange = "\"abc\"", ifNoneMatch = null).use { response ->
            assertEquals(206, response.code)
            assertEquals("\"abc\"", response.etag)
            assertEquals("bytes 6-9/10", response.contentRange)
            assertArrayEquals("rest".toByteArray(), response.body!!.readBytes())
        }
        val request = requests.single()
        assertEquals("$base/files/download/42", request.url.toString())
        assertEquals("bytes=6-", request.header("Range"))
        assertEquals("\"abc\"", request.header("If-Range"))
        assertNull(request.header("If-None-Match"))
        assertEquals("byte offsets must not be gzip-shifted", "identity", request.header("Accept-Encoding"))
    }

    @Test
    fun aRevalidationSendsIfNoneMatchAndARefusalCarriesItsText() {
        answer = { respond(it, 404, "Файл не найден") }
        client.get(7, rangeFrom = null, ifRange = null, ifNoneMatch = "\"abc\"").use { response ->
            assertEquals(404, response.code)
            assertNull(response.body)
            assertEquals("Файл не найден", response.errorText)
        }
        assertEquals("\"abc\"", requests.single().header("If-None-Match"))
        assertNull(requests.single().header("Range"))
    }

    @Test
    fun anExpiredSessionOnDownloadGoesThroughTheSessionRules() {
        answer = { respond(it, 401, """{"error":"Недействительный сессионный токен"}""") }
        try {
            client.get(7, null, null, null)
            fail()
        } catch (e: ApiException) {
            assertEquals(401, e.statusCode)
        }
        assertEquals(listOf(401), failures)
    }

    @Test
    fun theThumbnailAddressIsOnTheConfiguredServer() {
        assertEquals("$base/files/thumb/5?size=m", client.thumbnailUrl(5))
    }
}
