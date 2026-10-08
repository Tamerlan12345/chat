package com.openmychat.mobile.contract

import com.openmychat.mobile.data.model.FilePolicy
import com.openmychat.mobile.features.attachments.AttachmentDownloader
import com.openmychat.mobile.features.attachments.UploadRules
import com.openmychat.mobile.features.auth.formatCountdown
import com.openmychat.mobile.features.chat.ChatTexts
import com.openmychat.mobile.features.chat.DeliveryNotices
import com.openmychat.mobile.features.profile.ProfileTexts
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The shared Russian copy (mobile/contracts/copy/ru.json, keys of copy-ru.md): every state Android
 * shows that the table names uses the canonical text.
 */
class CopyRuTest {

    private val appDir: File = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .map { if (File(it, "app/build.gradle.kts").isFile) File(it, "app") else it }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main").isDirectory }

    private val canonical: JsonObject = run {
        Json.parseToJsonElement(File(appDir, "../../contracts/copy/ru.json").readText()).jsonObject
    }

    private fun text(key: String): String = (canonical[key] as? JsonPrimitive)?.content ?: error("no key $key")
    private fun plural(key: String, quantity: String): String =
        (canonical[key]?.jsonObject?.get(quantity) as? JsonPrimitive)?.content ?: error("no key $key.$quantity")

    private val xml = File(appDir, "src/main/res/values/strings.xml").readText()

    private fun unescape(raw: String) = raw.trim().replace("\\'", "'").replace("\\\"", "\"").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")

    private val strings: Map<String, String> = Regex("""<string name="([^"]+)"[^>]*>(.*?)</string>""", RegexOption.DOT_MATCHES_ALL)
        .findAll(xml).associate { it.groupValues[1] to unescape(it.groupValues[2]) }

    private fun pluralItem(name: String, quantity: String): String {
        val block = Regex("""<plurals name="$name">(.*?)</plurals>""", RegexOption.DOT_MATCHES_ALL).find(xml)?.groupValues?.get(1)
            ?: error("no plurals $name")
        return Regex("""<item quantity="$quantity">(.*?)</item>""").find(block)?.groupValues?.get(1)?.let(::unescape)
            ?: error("no $quantity in $name")
    }

    /** Android resource → canonical key, with the canonical placeholders written as format specifiers. */
    private val resources = listOf(
        "profile_logout_title" to "signout.title",
        "profile_logout_message" to "signout.body",
        "profile_logout_unsent_unknown" to "signout.unsent_unknown",
        "profile_logout" to "signout.confirm",
        "delivery_failed" to "delivery.failed",
        "delivery_failed_with_reason" to "delivery.failed_with_reason",
        "action_retry" to "delivery.retry",
        "action_delete" to "delivery.discard",
        "safety_block_title" to "block.confirm.title",
        "safety_block_message" to "block.confirm.body",
        "safety_block" to "block.confirm.action",
        "safety_blocked" to "block.done",
        "safety_unblock" to "unblock.action",
        "safety_unblocked" to "unblock.done",
        "blocked_unblock_failed" to "unblock.failed",
        "chat_blocked_banner" to "chat.blocked_by_me.banner",
        "blocked_title" to "blocked.list.title",
        "blocked_empty" to "blocked.list.empty",
        "blocked_empty_message" to "blocked.list.empty_hint",
        "blocked_footer" to "blocked.list.footer",
        "blocked_load_failed" to "blocked.list.load_failed",
        "delete_warning" to "delete.warning",
        "delete_dialog_title" to "delete.confirm.title",
        "delete_dialog_message" to "delete.confirm.body",
        "account_error_wrong_password" to "delete.wrong_password",
        "account_error_last_admin" to "delete.last_admin",
        "chat_dm_not_allowed" to "chat.dm_not_allowed.banner",
        "chat_composer_unavailable" to "chat.composer.locked_placeholder",
        "chat_empty_locked" to "chat.empty.locked",
        "account_error_registration_disabled" to "reg.disabled",
        "account_error_busy" to "reg.busy",
        "account_error_throttled" to "reg.throttled",
        "account_error_mail_not_configured" to "reg.mail_not_configured",
        "account_error_mail_send_failed" to "reg.mail_send_failed",
        "account_error_username_taken" to "reg.username_taken",
        "account_error_email_taken" to "reg.email_taken",
        "account_error_conflict" to "reg.conflict",
        "account_error_invalid_input" to "reg.invalid_input",
        "account_error_wrong_code" to "reg.wrong_code",
        "account_error_attempts_left" to "reg.attempts_left",
        "account_error_code_expired" to "reg.code_expired",
        "register_code_expired" to "reg.code_expired_local",
        "account_error_offline" to "reg.offline",
        "account_error_unavailable" to "reg.unavailable",
        "account_error_storage" to "reg.storage",
        "account_pending_title" to "reg.pending.title",
        "account_pending_message" to "reg.pending.body",
        "account_pending_login_message" to "login.pending.body",
        "account_rejected_title" to "login.rejected.title",
        "account_rejected_message" to "login.rejected.body",
        "login_error_busy" to "login.busy",
        "login_error_invalid_credentials" to "login.invalid",
        "login_error_offline" to "login.offline",
        "connection_offline" to "conn.offline",
        "connection_reconnecting" to "conn.reconnecting",
        "connection_back_online" to "conn.back_online",
        "connection_refused" to "conn.refused",
        "connection_signed_out" to "conn.signed_out",
        "attachment_failed" to "upload.failed_badge",
        "attachment_no_app" to "open.no_app"
    )

    private fun android(canonicalText: String): String = canonicalText
        .replace("{name}", "%1\$s")
        .replace("{wait}", "%1\$s")
        .replace("{reason}", "%1\$s")
        .replace("{text}", "%1\$s")
        .replace("{count}", if ("{text}" in canonicalText) "%2\$d" else "%d")

    @Test
    fun androidResourcesUseTheCanonicalTexts() {
        val mismatches = resources.mapNotNull { (name, key) ->
            val expected = android(text(key))
            val actual = strings[name] ?: return@mapNotNull "$name: missing"
            if (actual == expected) null else "$name ($key):\n  expected «$expected»\n  actual   «$actual»"
        }
        assertEquals(mismatches.joinToString("\n"), 0, mismatches.size)
    }

    @Test
    fun theUnsentLineOfTheSignOutUsesTheCanonicalPlurals() {
        listOf("one", "few", "many", "other").forEach { quantity ->
            assertEquals(quantity, android(plural("signout.unsent", quantity)), pluralItem("profile_logout_unsent", quantity))
        }
    }

    @Test
    fun deliveryNoticesUseTheCanonicalTexts() {
        listOf("EMPTY_TEXT", "TEXT_TOO_LONG", "NOT_EDITABLE", "EDIT_REJECTED", "NOT_DELETABLE", "DELETE_REJECTED", "DELETE_NOT_CONFIRMED")
            .forEach { code -> assertEquals(code, text("delivery.$code"), DeliveryNotices.text(code)) }
        listOf("INVALID_CLIENT_MSG_ID", "INVALID_CONVERSATION", "INVALID_MESSAGE_TYPE")
            .forEach { code -> assertEquals(code, text("delivery.INVALID_KEY"), DeliveryNotices.text(code)) }
        assertEquals(text("delivery.NOT_SAVED"), DeliveryNotices.NOT_SAVED)
        assertEquals(text("delivery.DM_NOT_ALLOWED"), DeliveryNotices.DM_NOT_ALLOWED)
        assertEquals(text("delivery.reason.max_attempts"), ChatTexts.REASON_NO_ANSWER)
        assertEquals(text("delivery.reason.rejected"), ChatTexts.REASON_REJECTED)
        assertEquals(text("signout.failed_unsent"), ProfileTexts.UNSENT_NOT_DELETED)
    }

    @Test
    fun attachmentTextsUseTheCanonicalTexts() {
        val policy = FilePolicy(enabled = true, allowed = listOf("pdf"))
        assertEquals(text("upload.empty"), UploadRules.problem("a.pdf", 0, null))
        assertEquals(text("upload.too_big"), UploadRules.problem("a.pdf", UploadRules.MAX_BYTES + 1, null))
        assertEquals(text("upload.no_extension"), UploadRules.problem("README", 10, policy))
        assertEquals(text("upload.ext_not_allowed").replace("{ext}", "exe"), UploadRules.problem("setup.exe", 10, policy))
        assertEquals(text("upload.refused"), UploadRules.REFUSED)
        assertEquals(text("upload.no_network"), UploadRules.NO_NETWORK)
        assertEquals(text("upload.cannot_prepare"), ChatTexts.CANNOT_PREPARE_FILE)
        assertEquals(text("download.no_network"), AttachmentDownloader.NO_NETWORK)
        assertEquals(text("download.interrupted"), AttachmentDownloader.INTERRUPTED)
        assertEquals(text("download.forbidden"), AttachmentDownloader.FORBIDDEN)
        assertEquals(text("download.not_found"), AttachmentDownloader.NOT_FOUND)
        assertEquals(text("download.failed"), AttachmentDownloader.FAILED)
    }

    /** `{wait}`: «45 с» under a minute, otherwise «2 мин 30 с», or «10 мин» when the seconds are 0. */
    @Test
    fun waitsReadTheSameEverywhere() {
        assertEquals("45 с", formatCountdown(45))
        assertEquals("2 мин 30 с", formatCountdown(150))
        assertEquals("10 мин", formatCountdown(600))
    }
}
