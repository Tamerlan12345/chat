package com.openmychat.mobile.build

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The dev stand's CA may be trusted by debug builds only, and never committed. */
class DebugOnlyTrustTest {

    private val appDir: File = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .map { if (File(it, "app/build.gradle.kts").isFile) File(it, "app") else it }
        .first { File(it, "build.gradle.kts").isFile && File(it, "src/main").isDirectory }

    @Test
    fun releaseHasNoNetworkSecurityOverride() {
        assertFalse(File(appDir, "src/main/AndroidManifest.xml").readText().contains("networkSecurityConfig"))
        val mainXml = File(appDir, "src/main/res").walkTopDown().filter { it.extension == "xml" }
        assertEquals(emptyList<String>(), mainXml.filter { "trust-anchors" in it.readText() }.map { it.name }.toList())
        assertFalse(File(appDir, "src/release").exists())
    }

    @Test
    fun debugTrustsTheDevCaOnlyForLocalHostsThroughTheGeneratedOverlay() {
        val config = File(appDir, "src/debug/res/xml/debug_network_security_config.xml").readText()
        assertTrue(config.contains("<!-- dev-ca-trust-anchors -->"))
        assertFalse("user-installed CAs are never trusted", config.contains("src=\"user\""))
        assertFalse("the base config holds no certificate itself", config.contains("<certificates"))
        val script = File(appDir, "build.gradle.kts").readText()
        assertTrue(script.contains("onVariants(selector().withBuildType(\"debug\"))"))
    }

    @Test
    fun noCertificateOrKeyIsCommittedUnderSrc() {
        val material = File(appDir, "src").walkTopDown()
            .filter { it.isFile && it.extension.lowercase() in setOf("pem", "crt", "cer", "der", "key", "p12") }
            .map { it.name }.toList()
        assertEquals(emptyList<String>(), material)
    }
}
