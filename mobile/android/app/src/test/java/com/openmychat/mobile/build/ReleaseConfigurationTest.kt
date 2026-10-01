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

    private fun projectBuildScript(): File =
        generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "app/build.gradle.kts") }
            .firstOrNull(File::isFile)
            ?: error("Unable to locate app/build.gradle.kts from the test working directory")

    private fun buildTypeBlock(name: String): MatchResult? =
        Regex("""(?ms)^\s*$name\s*\{(?<body>.*?)^\s*}""")
            .find(projectBuildScript().readText())
}
