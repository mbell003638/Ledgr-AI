package expo.modules.ledgrnativeai

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Bundled Needle 2 (libneedle.a + needle2.cact) plus optional Gemma file downloads.
 * Gemma inference is a later pack; Needle tool-calling is the on-device default.
 */
class LedgrOnDeviceLlmModule : Module() {
  @Volatile private var engineLoaded = false
  @Volatile private var lastToolsJson = ""

  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("LedgrOnDeviceLlm")
    Events("downloadProgress")

    AsyncFunction("isAvailable") { needleReady() }

    AsyncFunction("getStatus") {
      val ram = totalRamBytes()
      mapOf(
        "supported" to true,
        "needleAvailable" to needleReady(),
        "engineLoaded" to engineLoaded,
        "reason" to if (needleReady()) null else missingEngineReason(),
        "totalRamBytes" to ram,
      )
    }

    AsyncFunction("runNeedle") { transcript: String, toolsJson: String ->
      ensureNeedle(toolsJson)
      NeedleJni.complete(transcript, 128)
    }

    AsyncFunction("runOptional") { modelId: String, prompt: String, imageUri: String?, audioUri: String? ->
      val file = optionalFile(modelId)
      if (!file.exists()) throw IllegalStateException("Download this on-device model in Advanced Settings first.")
      throw IllegalStateException("Gemma packs are stored on the phone, but on-device Gemma inference is not wired in this native build yet. Needle handles commands; cloud or a later APK runs Gemma.")
    }

    AsyncFunction("listOptional") {
      val ram = totalRamBytes()
      OPTIONAL_MODELS.map { spec ->
        val file = optionalFile(spec.id)
        mapOf(
          "id" to spec.id,
          "installed" to file.exists(),
          "eligible" to (ram <= 0L || ram >= spec.minRamBytes),
          "bytesOnDisk" to if (file.exists()) file.length() else 0L,
        )
      }
    }

    AsyncFunction("downloadOptional") { modelId: String, url: String, filename: String ->
      val spec = OPTIONAL_MODELS.firstOrNull { it.id == modelId } ?: throw IllegalArgumentException("Unknown model")
      if (url.isBlank()) {
        throw IllegalStateException("This Gemma pack has no download URL. Convert it with cactus download and copy ${spec.filename} onto the phone.")
      }
      val ram = totalRamBytes()
      if (ram > 0 && ram < spec.minRamBytes) {
        throw IllegalStateException("This phone does not have enough RAM for ${spec.id}.")
      }
      optionalDir().listFiles()?.forEach { child ->
        if (child.isFile && child.name != filename) child.delete()
      }
      downloadTo(url, optionalFile(modelId), modelId)
      true
    }

    AsyncFunction("deleteOptional") { modelId: String ->
      optionalFile(modelId).delete()
      true
    }

    OnDestroy {
      if (engineLoaded) {
        try { NeedleJni.reset() } catch (_: Throwable) {}
      }
      engineLoaded = false
    }
  }

  private fun needleReady(): Boolean {
    return engineLoaded || bundledNeedleBytes() != null
  }

  private fun missingEngineReason(): String {
    return if (bundledNeedleBytes() == null) {
      "Needle weights are missing. Run frontend/scripts/on-device-ai/fetch-native.mjs then rebuild the Android APK."
    } else {
      "Needle is in the project, but this JS bundle is not a native APK. Run npx expo run:android or EAS."
    }
  }

  private fun ensureNeedle(toolsJson: String) {
    if (!engineLoaded) {
      val cact = bundledNeedleBytes() ?: throw IllegalStateException(missingEngineReason())
      try {
        if (NeedleJni.load(cact) != 0) throw IllegalStateException("Needle could not load needle2.cact.")
      } catch (error: UnsatisfiedLinkError) {
        throw IllegalStateException("Needle native library is missing. Rebuild the Android APK after fetch-native.mjs.", error)
      }
      engineLoaded = true
      lastToolsJson = ""
    }
    if (toolsJson != lastToolsJson) {
      if (NeedleJni.init("You convert shop bookkeeping speech into one Ledgr tool call. Never invent IDs. Return JSON only.", toolsJson) != 0) {
        throw IllegalStateException("Needle could not load the Ledgr tool list.")
      }
      lastToolsJson = toolsJson
    }
  }

  private fun bundledNeedleBytes(): ByteArray? {
    return try {
      context.assets.open("needle2.cact").use { it.readBytes() }.takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
      null
    }
  }

  private fun modelsDir(): File = File(context.filesDir, "on-device-models").apply { mkdirs() }
  private fun optionalDir(): File = File(modelsDir(), "optional").apply { mkdirs() }
  private fun optionalFile(id: String): File {
    val spec = OPTIONAL_MODELS.firstOrNull { it.id == id } ?: throw IllegalArgumentException("Unknown model")
    return File(optionalDir(), spec.filename)
  }

  private fun totalRamBytes(): Long {
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val info = ActivityManager.MemoryInfo()
    manager.getMemoryInfo(info)
    return if (Build.VERSION.SDK_INT >= 16) info.totalMem else 0L
  }

  private fun downloadTo(url: String, dest: File, id: String) {
    dest.parentFile?.mkdirs()
    val tmp = File(dest.parentFile, dest.name + ".part")
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.instanceFollowRedirects = true
    connection.connectTimeout = 15000
    connection.readTimeout = 30000
    connection.connect()
    if (connection.responseCode !in 200..299) {
      throw IllegalStateException("Download failed (${connection.responseCode}). Convert the Gemma pack with cactus download and copy it onto the phone.")
    }
    val total = connection.contentLengthLong.let { if (it > 0) it else 0L }
    connection.inputStream.use { input ->
      FileOutputStream(tmp).use { output ->
        val buffer = ByteArray(1024 * 64)
        var received = 0L
        while (true) {
          val read = input.read(buffer)
          if (read <= 0) break
          output.write(buffer, 0, read)
          received += read
          sendEvent("downloadProgress", mapOf("id" to id, "received" to received, "total" to total))
        }
      }
    }
    if (dest.exists()) dest.delete()
    if (!tmp.renameTo(dest)) throw IllegalStateException("Could not save the downloaded model.")
  }

  companion object {
    private data class OptionalSpec(val id: String, val filename: String, val minRamBytes: Long)
    private val OPTIONAL_MODELS = listOf(
      OptionalSpec("gemma-3-1b", "gemma-3-1b-it.cact", (5.5 * 1024 * 1024 * 1024).toLong()),
      OptionalSpec("gemma-4-e2b", "gemma-4-e2b-it.cact", (7.5 * 1024 * 1024 * 1024).toLong()),
      OptionalSpec("gemma-4-e4b", "gemma-4-e4b-it.cact", (11L * 1024 * 1024 * 1024)),
    )
  }
}
