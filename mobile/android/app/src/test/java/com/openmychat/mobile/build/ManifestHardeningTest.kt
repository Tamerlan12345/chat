package com.openmychat.mobile.build

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Final review M5 and I3: what the release manifest promises. */
class ManifestHardeningTest {

    private val appDir: File = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .map { if (File(it, "app/build.gradle.kts").isFile) File(it, "app") else it }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main").isDirectory }

    private val manifest get() = File(appDir, "src/main/AndroidManifest.xml").readText()

    @Test
    fun cleartextIsOffInTheReleaseManifestEvenOnApi26And27() {
        val application = Regex("""(?s)<application\b(.*?)>""").find(manifest)!!.groupValues[1]
        assertTrue(application.contains("""android:usesCleartextTraffic="false""""))
    }

    @Test
    fun notificationTapsArriveThroughANonExportedActivity() {
        val declaration = Regex("""(?s)<activity\s[^>]*android:name="\.data\.notifications\.NotificationOpenActivity"[^>]*>""")
            .find(manifest)?.value
        assertTrue("NotificationOpenActivity must be declared", declaration != null)
        assertTrue(declaration!!, declaration.contains("""android:exported="false""""))
    }

    @Test
    fun theExportedLauncherNoLongerReadsChatExtras() {
        val main = File(appDir, "src/main/java/com/openmychat/mobile/MainActivity.kt").readText()
        assertFalse(main.contains("EXTRA_TARGET_ID"))
        assertFalse(main.contains("EXTRA_CONVERSATION_TYPE"))
        assertFalse(main.contains("getStringExtra"))
    }
}
