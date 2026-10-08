import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
    alias(libs.plugins.room)
}

// Push (decision P): Firebase Messaging is always compiled in, but the Google Services plugin (which
// turns app/google-services.json into the FirebaseApp configuration) is applied only when the owner
// has put that file in place. Without it the app builds, runs and passes CI with push simply off.
// The file is git-ignored: it is configuration of the owner's Firebase project, never committed.
if (file("google-services.json").isFile) {
    apply(plugin = libs.plugins.google.services.get().pluginId)
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

// Debug builds talk to the local HTTPS dev stand (mobile/dev/README.md) through the emulator's alias
// for the host, never to production by default: a connected test or a stray debug install must not
// send dev credentials to the real server. `-Pcentychat.serverUrl=https://host[:port]` overrides it
// (production only when asked for explicitly). Only a bare scheme://host[:port] is accepted.
val devStandServerUrl = "https://10.0.2.2:8443"
val debugServerUrl: String = providers.gradleProperty("centychat.serverUrl").orNull
    ?.trim()?.removeSuffix("/")?.takeIf { it.isNotEmpty() } ?: devStandServerUrl
require(Regex("""https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?""").matches(debugServerUrl)) {
    "centychat.serverUrl must look like https://host[:port], got '$debugServerUrl'"
}

// Release metadata is passed as Gradle project properties by the release pipeline. Harmless
// defaults keep debug and local unit-test builds independent of release credentials.
val releaseVersionCodeProperty = providers.gradleProperty("centychat.versionCode").orNull
val releaseVersionNameProperty = providers.gradleProperty("centychat.versionName").orNull
val configuredVersionCode = releaseVersionCodeProperty?.toIntOrNull() ?: 1
val configuredVersionName = releaseVersionNameProperty?.takeIf { it.isNotBlank() } ?: "1.0.0"

// A local keystore.properties file is git-ignored. Environment values override it, which also
// supports CI secret stores without writing signing secrets to disk.
val localSigningProperties = Properties().apply {
    rootProject.file("keystore.properties").takeIf(File::isFile)?.inputStream()?.use(::load)
}
fun signingValue(environmentName: String, propertyName: String): String? =
    providers.environmentVariable(environmentName).orNull?.takeIf { it.isNotBlank() }
        ?: localSigningProperties.getProperty(propertyName)?.takeIf { it.isNotBlank() }

val releaseStorePath = signingValue("CENTYCHAT_KEYSTORE_FILE", "storeFile")
val releaseStorePassword = signingValue("CENTYCHAT_KEYSTORE_PASSWORD", "storePassword")
val releaseKeyAlias = signingValue("CENTYCHAT_KEY_ALIAS", "keyAlias")
val releaseKeyPassword = signingValue("CENTYCHAT_KEY_PASSWORD", "keyPassword")

android {
    namespace = "com.openmychat.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.openmychat.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = configuredVersionCode
        versionName = configuredVersionName

        testInstrumentationRunner = "com.openmychat.mobile.HiltTestRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    signingConfigs {
        create("release") {
            if (releaseStorePath != null) storeFile = rootProject.file(releaseStorePath)
            if (releaseStorePassword != null) storePassword = releaseStorePassword
            if (releaseKeyAlias != null) keyAlias = releaseKeyAlias
            if (releaseKeyPassword != null) keyPassword = releaseKeyPassword
        }
    }
    buildTypes {
        debug {
            isDebuggable = true
            buildConfigField("String", "SERVER_URL", "\"$debugServerUrl\"")
        }

        release {
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("release")
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

// Android otherwise permits unsigned release artifacts when no signing config is populated.
// Attach an explicit guard to every artifact-producing release task to fail closed.
val validateReleaseSigning = tasks.register("validateReleaseSigning") {
    group = "verification"
    description = "Validates release version metadata and signing material without printing secrets."
    doLast {
        require(releaseVersionCodeProperty?.toIntOrNull()?.let { it > 0 } == true) {
            "Release builds require -Pcentychat.versionCode=<positive integer>."
        }
        require(!releaseVersionNameProperty.isNullOrBlank()) {
            "Release builds require -Pcentychat.versionName=<version string>."
        }
        val missing = buildList {
            if (releaseStorePath.isNullOrBlank()) add("CENTYCHAT_KEYSTORE_FILE / storeFile")
            if (releaseStorePassword.isNullOrBlank()) add("CENTYCHAT_KEYSTORE_PASSWORD / storePassword")
            if (releaseKeyAlias.isNullOrBlank()) add("CENTYCHAT_KEY_ALIAS / keyAlias")
            if (releaseKeyPassword.isNullOrBlank()) add("CENTYCHAT_KEY_PASSWORD / keyPassword")
        }
        require(missing.isEmpty()) {
            "Release signing is not configured. Supply all signing values via environment variables or keystore.properties. Missing: ${missing.joinToString()}"
        }
        require(rootProject.file(requireNotNull(releaseStorePath)).isFile) {
            "Release keystore file was not found. Check CENTYCHAT_KEYSTORE_FILE or storeFile."
        }
    }
}

tasks.configureEach {
    if (Regex("^(assemble|bundle|package|sign|validateSigning).*Release.*$").matches(name)) {
        dependsOn(validateReleaseSigning)
    }
}

// Room exports every schema version: the outbox may hold unsent text, so its table only ever migrates.
room {
    schemaDirectory("$projectDir/schemas")
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
    // XML window theme (DayNight, no white flash before Compose draws) and the SplashScreen API.
    implementation(libs.google.material)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    // Присутствие «в сети / отошёл» по жизненному циклу всего процесса (ProcessLifecycleOwner).
    implementation(libs.androidx.lifecycle.process)
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
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.androidx.security.crypto)
    implementation("com.google.errorprone:error_prone_annotations:2.18.0")

    // Durable outbox and conversation cache (delivery-state.md): Room; background flush: WorkManager.
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.work.runtime.ktx)

    // Push (decision P): FCM data messages with ids only (mobile/contracts/push.md).
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

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

/**
 * Debug builds only: trust the local dev stand's CA (mobile/dev/certs/dev-ca.crt, created by
 * `node mobile/dev/stand.mjs` and git-ignored) for the local development hosts.
 *
 * When the CA file exists, this writes a generated resource overlay with the certificate as
 * `raw/centychat_dev_ca` and a copy of src/debug/res/xml/debug_network_security_config.xml whose
 * marker comment is replaced by trust anchors (system + dev CA). Without the file nothing is
 * generated and the checked-in config applies. The certificate never enters the source tree and
 * the release build type is never touched.
 */
abstract class DevCaResourcesTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val devCa: ConfigurableFileCollection

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val baseConfig: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        val ca = devCa.files.firstOrNull { it.isFile } ?: return
        val pem = ca.readText()
        check("-----BEGIN CERTIFICATE-----" in pem && "PRIVATE KEY" !in pem) {
            "$ca must be a PEM certificate without any private key"
        }
        val marker = "<!-- dev-ca-trust-anchors -->"
        val base = baseConfig.get().asFile.readText()
        check(marker in base) { "debug_network_security_config.xml lost its $marker marker" }
        File(out, "raw").mkdirs()
        File(out, "raw/centychat_dev_ca.pem").writeText(pem)
        File(out, "xml").mkdirs()
        File(out, "xml/debug_network_security_config.xml").writeText(
            base.replace(
                marker,
                """<trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/centychat_dev_ca" />
        </trust-anchors>"""
            )
        )
    }
}

val generateDebugDevCaResources = tasks.register<DevCaResourcesTask>("generateDebugDevCaResources") {
    devCa.from(rootDir.resolve("../dev/certs/dev-ca.crt"))
    baseConfig.set(layout.projectDirectory.file("src/debug/res/xml/debug_network_security_config.xml"))
}

androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(generateDebugDevCaResources, DevCaResourcesTask::outputDir)
    }
}
