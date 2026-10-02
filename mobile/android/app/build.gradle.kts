import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// The JVM test worker cannot load classes from a build directory whose path
// contains non-ASCII characters on Windows (sun.jnu.encoding is not UTF-8),
// so redirect build output to an ASCII-only location in that case. The folder
// name carries a hash of the checkout path so parallel worktrees never share
// (and lock) each other's intermediates.
if (!projectDir.absolutePath.all { it.code < 128 }) {
    val checkoutId = rootDir.absolutePath.hashCode().toUInt().toString(16)
    layout.buildDirectory.set(
        File(System.getProperty("java.io.tmpdir"), "centychat-android-build/${rootProject.name}-$checkoutId/app")
    )
}

// The production server. Release builds always use it: there is no server field, no runtime
// override and no build property that reaches the release build type.
val productionServerUrl = "https://centychat-production.up.railway.app"

// Debug builds only: `-Pcentychat.serverUrl=https://10.0.2.2:8443` points the app at the local dev
// stand (mobile/dev/README.md). Defaults to production. Only a bare scheme://host[:port] is accepted.
val debugServerUrl: String = providers.gradleProperty("centychat.serverUrl").orNull
    ?.trim()?.removeSuffix("/")?.takeIf { it.isNotEmpty() } ?: productionServerUrl
require(Regex("""https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?""").matches(debugServerUrl)) {
    "centychat.serverUrl must look like https://host[:port], got '$debugServerUrl'"
}

android {
    namespace = "com.openmychat.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.openmychat.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "com.openmychat.mobile.HiltTestRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    buildTypes {
        debug {
            isDebuggable = true
            buildConfigField("String", "SERVER_URL", "\"$debugServerUrl\"")
        }

        release {
            isMinifyEnabled = true
            buildConfigField("String", "SERVER_URL", "\"$productionServerUrl\"")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        freeCompilerArgs.addAll(
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
            "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi"
        )
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.material3.adaptive.navigation.suite)
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)

    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.okhttp)
    implementation(libs.androidx.security.crypto)
    implementation("com.google.errorprone:error_prone_annotations:2.18.0")

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.androidx.hilt.lifecycle.viewmodel.compose)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.hilt.android.testing)
    kspAndroidTest(libs.hilt.compiler)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.ui.test.junit4)
    debugImplementation(libs.androidx.ui.tooling)
    debugImplementation(libs.androidx.ui.test.manifest)
}

// ContractFixturesTest reads mobile/contracts/fixtures at test time; rerun the tests when they change.
tasks.withType<Test>().configureEach {
    inputs.dir(rootDir.resolve("../contracts/fixtures"))
        .withPropertyName("contractFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}
