package com.openmychat.mobile.build

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

/** Source-level guards for the threat model: the password is never logged or persisted. */
class CredentialHygieneTest {

    private val appDir: File = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .map { if (File(it, "app/build.gradle.kts").isFile) File(it, "app") else it }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main").isDirectory }

    private val mainSources: List<File> = File(appDir, "src/main/java").walkTopDown().filter { it.extension == "kt" }.toList()

    @Test
    fun noHttpBodyLoggingCanPrintTheLoginRequest() {
        assertFalse(
            "the OkHttp logging interceptor would print the login body (password) to logcat",
            File(appDir, "build.gradle.kts").readText().contains("okhttp.logging")
        )
        assertEquals(emptyList<String>(), mainSources.filter { it.readText().contains("HttpLoggingInterceptor") }.map { it.name })
    }

    @Test
    fun authenticationCodeDoesNotLog() {
        val logging = Regex("""\bLog\.[vdiwe]\(|println\(|printStackTrace\(""")
        val offenders = mainSources
            .filter { it.path.replace('\\', '/').let { path -> "/features/auth/" in path || "/core/network/" in path || "/core/session/" in path } }
            .filter { logging.containsMatchIn(it.readText()) }
            .map { it.name }
        assertEquals(emptyList<String>(), offenders)
    }

    @Test
    fun thePasswordFieldIsNeverSavedIntoInstanceState() {
        val screen = File(appDir, "src/main/java/com/openmychat/mobile/features/auth/LoginScreen.kt").readText()
        val viewModel = File(appDir, "src/main/java/com/openmychat/mobile/features/auth/LoginViewModel.kt").readText()

        // rememberSaveable / SavedStateHandle write to the saved-state bundle, which can reach disk.
        assertFalse(screen.contains("rememberSaveable"))
        assertFalse(viewModel.contains("SavedStateHandle"))
    }
}
