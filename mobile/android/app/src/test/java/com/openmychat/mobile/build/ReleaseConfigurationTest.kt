package com.openmychat.mobile.build

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ReleaseConfigurationTest {

    @Test
    fun releaseBuildEnablesMinification() {
        val releaseBlock = Regex(
            """(?ms)^\s*release\s*\{(?<body>.*?)^\s*}"""
        ).find(projectBuildScript().readText())

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
}
