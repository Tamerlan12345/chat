package com.openmychat.mobile.build

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ReleaseConfigurationTest {

    @Test
    fun debugBuildIsExplicitlyDebuggable() {
        val debugBlock = buildTypeBlock("debug")

        assertTrue(
            "debug build type must be explicitly declared",
            debugBlock != null
        )
        assertTrue(
            "debug build type must explicitly be debuggable",
            Regex("""(?m)^\s*isDebuggable\s*=\s*true\s*$""")
                .containsMatchIn(debugBlock!!.groups["body"]!!.value)
        )
    }

    @Test
    fun releaseBuildEnablesMinification() {
        val releaseBlock = buildTypeBlock("release")

        assertTrue("release build type must be declared", releaseBlock != null)
        assertTrue(
            "release build type must enable R8 minification",
            Regex("""(?m)^\s*isMinifyEnabled\s*=\s*true\s*$""")
                .containsMatchIn(releaseBlock!!.groups["body"]!!.value)
        )
    }

    @Test
    fun debugDefaultsToTheLocalDevStandNeverProduction() {
        val script = projectBuildScript().readText()
        val debugBody = buildTypeBlock("debug")!!.groups["body"]!!.value
        assertTrue(
            "the dev stand constant must be the emulator alias of the local stand",
            script.contains("val devStandServerUrl = \"https://10.0.2.2:8443\"")
        )
        assertTrue(
            "without -Pcentychat.serverUrl a debug build must talk to the dev stand, not production",
            Regex("""debugServerUrl[^
]*
[^
]*?: devStandServerUrl""").containsMatchIn(script)
        )
        assertTrue("debug SERVER_URL comes from debugServerUrl", debugBody.contains("\$debugServerUrl"))
    }

    @Test
    fun releaseBuildHardCodesTheProductionServer() {
        val script = projectBuildScript().readText()
        val releaseBody = buildTypeBlock("release")!!.groups["body"]!!.value

        assertTrue(
            "the production server constant must be the Railway deployment",
            script.contains("val productionServerUrl = \"https://centychat-production.up.railway.app\"")
        )
        assertTrue(
            "release SERVER_URL must be the production constant",
            releaseBody.lines().map { it.trim() }
                .contains("buildConfigField(\"String\", \"SERVER_URL\", \"\\\"\$productionServerUrl\\\"\")")
        )
        assertTrue(
            "release must not read the debug-only centychat.serverUrl override",
            !releaseBody.contains("centychat.serverUrl") && !releaseBody.contains("debugServerUrl")
        )
    }

    private fun projectBuildScript(): File =
        generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "app/build.gradle.kts") }
            .firstOrNull(File::isFile)
            ?: error("Unable to locate app/build.gradle.kts from the test working directory")

    private fun buildTypeBlock(name: String): MatchResult? =
        Regex("""(?ms)^\s*$name\s*\{(?<body>.*?)^\s*}""")
            .find(projectBuildScript().readText())
}
