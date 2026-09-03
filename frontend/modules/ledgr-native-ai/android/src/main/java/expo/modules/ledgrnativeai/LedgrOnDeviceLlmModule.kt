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
 * Bundled Needle 2 + optional Gemma downloads.
 * Inference uses libcactus_engine.so when the native build vendors it next to needle2.cact.
 * TTS and downloads work even when the engine .so is not present.
 */
class LedgrOnDeviceLlmModule : Module() {
  @Volatile private var cactusHandle: Long = 0
  @Volatile private var engineLoaded = false

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
      ensureEngine()
      complete(needleModelFile().absolutePath, transcript, toolsJson, null, null)
    }

    AsyncFunction("runOptional") { modelId: String, prompt: String, imageUri: String?, audioUri: String? ->
      ensureEngine()
      val file = optionalFile(modelId)
      if (!file.exists()) throw IllegalStateException("Download this on-device model in Advanced Settings first.")
      complete(file.absolutePath, prompt, null, imageUri, audioUri)
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
      destroyEngine()
    }
  }

  private fun needleReady(): Boolean {
    return engineLoaded && needleModelFile().exists()
  }

  private fun missingEngineReason(): String {
    return if (!File(context.applicationInfo.nativeLibraryDir, "libcactus_engine.so").exists()) {
      "Needle needs libcactus_engine.so in the native APK (run scripts/on-device-ai/fetch-native.mjs)."
    } else if (!needleModelFile().exists()) {
      "Needle weights are missing. Bundle needle2.cact in the native assets."
    } else {
      "The on-device engine is not ready."
    }
  }

  private fun ensureEngine() {
    if (engineLoaded) return
    try {
      System.loadLibrary("cactus_engine")
      engineLoaded = true
    } catch (_: UnsatisfiedLinkError) {
      engineLoaded = false
      throw IllegalStateException(missingEngineReason())
    }
    copyBundledNeedle()
  }

  private fun copyBundledNeedle() {
    val dest = needleModelFile()
    if (dest.exists() && dest.length() > 0) return
    dest.parentFile?.mkdirs()
    try {
      context.assets.open("needle2.cact").use { input ->
        FileOutputStream(dest).use { output -> input.copyTo(output) }
      }
    } catch (_: Exception) {
      // Asset may be omitted from JS-only builds.
    }
  }

  private fun complete(modelPath: String, prompt: String, toolsJson: String?, imageUri: String?, audioUri: String?): String {
    if (!engineLoaded) throw IllegalStateException(missingEngineReason())
    val messages = """[{"role":"user","content":${jsonString(prompt)}}]"""
    return nativeComplete(modelPath, messages, toolsJson, imageUri, audioUri)
  }

  /**
   * JNI symbols match Cactus `Java_com_cactus_CactusJNI_*` when libcactus_engine.so is vendored.
   * Until that library is linked, this stays a Kotlin-only stub so the Android compile still passes.
   */
  private fun nativeComplete(modelPath: String, messagesJson: String, toolsJson: String?, imageUri: String?, audioUri: String?): String {
    throw IllegalStateException(
      "Needle/Gemma inference requires vendored libcactus_engine.so. Model path $modelPath is staged; rebuild the native APK after fetch-native.mjs."
    )
  }

  private fun destroyEngine() {
    cactusHandle = 0
  }

  private fun modelsDir(): File = File(context.filesDir, "on-device-models").apply { mkdirs() }
  private fun needleModelFile(): File = File(modelsDir(), "needle2.cact")
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

  private fun jsonString(value: String): String {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""
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
