package com.openmychat.mobile.features.attachments

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.FilePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The admin's file policy is checked before anything is uploaded, with the server's own Russian
 * wording (FilePolicyService.check, acceptUpload); what the server refuses later is shown as it says.
 */
class UploadRulesTest {

    private val policy = FilePolicy(enabled = true, allowed = listOf("pdf", "png", "jpg", "txt"))

    @Test
    fun anAllowedFilePasses() {
        assertNull(UploadRules.problem("Отчёт.PDF", 2048, policy))
    }

    @Test
    fun aTypeOutsideThePolicyIsRefusedLikeTheServerDoes() {
        assertEquals("Файлы .exe к отправке не разрешены", UploadRules.problem("setup.exe", 10, policy))
    }

    @Test
    fun aFileWithoutAnExtensionIsRefusedWhileThePolicyIsOn() {
        assertEquals("У файла нет расширения", UploadRules.problem("README", 10, policy))
        assertNull(UploadRules.problem("README", 10, policy.copy(enabled = false)))
    }

    @Test
    fun anEmptyPolicyListAllowsNothing() {
        assertEquals("Файлы .pdf к отправке не разрешены", UploadRules.problem("a.pdf", 10, FilePolicy(enabled = true, allowed = emptyList())))
    }

    @Test
    fun withoutAKnownPolicyOnlySizeIsChecked() {
        assertNull(UploadRules.problem("setup.exe", 10, null))
    }

    @Test
    fun emptyAndOversizedFilesAreRefusedBeforeUploading() {
        assertEquals("Файл пустой", UploadRules.problem("a.pdf", 0, policy))
        assertEquals("Файл больше 100 МБ — такой файл загрузить нельзя", UploadRules.problem("a.pdf", 100L * 1024 * 1024 + 1, policy))
        assertNull("unknown size is left to the server", UploadRules.problem("a.pdf", null, policy))
    }

    @Test
    fun theServersRefusalIsShownInItsOwnWords() {
        assertEquals(
            "Файлы .exe к отправке не разрешены",
            UploadRules.failureText(ApiException(415, "ext-not-allowed", "Файлы .exe к отправке не разрешены"))
        )
        assertEquals(
            "Файл больше 20 МБ — такой файл загрузить нельзя",
            UploadRules.failureText(ApiException(413, null, "Файл больше 20 МБ — такой файл загрузить нельзя"))
        )
        assertEquals(
            "Загрузка файлов не разрешена для вашей роли",
            UploadRules.failureText(ApiException(403, null, "Загрузка файлов не разрешена для вашей роли"))
        )
    }

    @Test
    fun aRefusalWithoutABodyOrANetworkFailureGetsARussianReason() {
        assertEquals("Сервер не принял файл", UploadRules.failureText(ApiException(502, null, "HTTP error 502")))
        assertEquals("Нет связи с сервером", UploadRules.failureText(ApiException(0, "NETWORK_ERROR", "timeout")))
        assertEquals("Сервер не принял файл", UploadRules.failureText(IllegalStateException("boom")))
    }
}
