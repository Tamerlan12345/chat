package com.openmychat.mobile.build

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Decision P: push code is always built, but the Firebase configuration is the owner's and optional.
 * Without app/google-services.json the Google Services plugin is not applied and push is off; the
 * file itself is never committed.
 */
class PushBuildConfigurationTest {

    private val appDir: File = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .map { if (File(it, "app/build.gradle.kts").isFile) File(it, "app") else it }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main").isDirectory }

    @Test
    fun theGoogleServicesPluginIsAppliedOnlyWhenTheConfigurationIsThere() {
        val script = File(appDir, "build.gradle.kts").readText()
        val plugins = Regex("""(?s)^plugins\s*\{(.*?)^}""", RegexOption.MULTILINE).find(script)!!.groupValues[1]
        assertFalse("never applied unconditionally", plugins.contains("google.services") || plugins.contains("google-services"))
        assertTrue(Regex("""if \(file\("google-services\.json"\)\.isFile\) \{\s*apply\(plugin""").containsMatchIn(script))
        assertTrue("Firebase Messaging is compiled in", script.contains("libs.firebase.messaging"))
    }

    @Test
    fun theConfigurationIsNeverCommitted() {
        val ignore = File(appDir.parentFile, ".gitignore").readText()
        assertTrue(ignore.lines().any { it.trim() == "app/google-services.json" })
    }

    @Test
    fun theMessagingServiceIsNotExported() {
        val manifest = File(appDir, "src/main/AndroidManifest.xml").readText()
        val service = Regex("""(?s)<service\s[^>]*android:name="\.data\.push\.CentyMessagingService"[^>]*>""").find(manifest)?.value
        assertTrue(service != null && service.contains("""android:exported="false""""))
    }
}
