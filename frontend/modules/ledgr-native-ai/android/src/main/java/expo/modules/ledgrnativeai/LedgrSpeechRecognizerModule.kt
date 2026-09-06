package expo.modules.ledgrnativeai

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

class LedgrSpeechRecognizerModule : Module(), RecognitionListener {
  private var recognizer: SpeechRecognizer? = null
  private var active = false
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("LedgrSpeechRecognizer")
    Events("partial", "final", "error", "end")
    AsyncFunction("isAvailable") { SpeechRecognizer.isRecognitionAvailable(context) }
    AsyncFunction("isOnDeviceAvailable") { onDeviceRecognitionAvailable() }
    AsyncFunction("start") { locale: String?, onDeviceOnly: Boolean? ->
      if (active) throw IllegalStateException("Speech recognition is already running")
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) throw SecurityException("Microphone permission is required for Android device recognition")
      if (!SpeechRecognizer.isRecognitionAvailable(context)) throw IllegalStateException("No Android speech recognition service is available")
      // EXTRA_PREFER_OFFLINE is only a hint: Google's recognizer ignores it
      // when the offline language pack is missing and falls back to its cloud
      // service, which is what raises the "send data to Google" consent
      // screen. When the user has chosen On-device only, use the recognizer
      // that has no cloud path at all so that setting's promise holds.
      val strictOnDevice = onDeviceOnly == true && onDeviceRecognitionAvailable()
      appContext.currentActivity?.runOnUiThread {
        destroyRecognizer()
        recognizer = createRecognizer(strictOnDevice).also {
          it.setRecognitionListener(this@LedgrSpeechRecognizerModule)
        }
        active = true
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale?.takeIf { it.isNotBlank() } ?: Locale.getDefault().toLanguageTag())
          if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
        recognizer?.startListening(intent)
      } ?: throw IllegalStateException("Android activity is unavailable")
    }
    AsyncFunction("stop") { appContext.currentActivity?.runOnUiThread { recognizer?.stopListening() } }
    AsyncFunction("cancel") { appContext.currentActivity?.runOnUiThread { recognizer?.cancel(); finishSession() } }
    AsyncFunction("destroy") { appContext.currentActivity?.runOnUiThread { destroyRecognizer() } }
    OnDestroy { destroyRecognizer() }
  }

  override fun onPartialResults(results: Bundle?) { bestResult(results)?.let { sendEvent("partial", mapOf("text" to it)) } }
  override fun onResults(results: Bundle?) { bestResult(results)?.let { sendEvent("final", mapOf("text" to it)) }; finishSession() }
  override fun onError(error: Int) { sendEvent("error", mapOf("code" to errorCode(error), "message" to errorMessage(error))); finishSession() }
  override fun onEndOfSpeech() = Unit
  override fun onReadyForSpeech(params: Bundle?) = Unit
  override fun onBeginningOfSpeech() = Unit
  override fun onRmsChanged(rmsdB: Float) = Unit
  override fun onBufferReceived(buffer: ByteArray?) = Unit
  override fun onEvent(eventType: Int, params: Bundle?) = Unit

  private fun onDeviceRecognitionAvailable(): Boolean =
    android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S &&
      SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

  private fun createRecognizer(strictOnDevice: Boolean): SpeechRecognizer =
    if (strictOnDevice && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
      SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
    } else {
      SpeechRecognizer.createSpeechRecognizer(context)
    }

  private fun bestResult(results: Bundle?): String? = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
  private fun finishSession() { if (!active) return; active = false; sendEvent("end"); recognizer?.destroy(); recognizer = null }
  private fun destroyRecognizer() { active = false; recognizer?.destroy(); recognizer = null }
  private fun errorCode(error: Int): String = when (error) {
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "PERMISSION_DENIED"
    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER -> "NETWORK"
    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "NO_RESULT"
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "BUSY"
    SpeechRecognizer.ERROR_CLIENT -> "CANCELLED"
    else -> "UNKNOWN"
  }
  private fun errorMessage(error: Int): String = when (errorCode(error)) {
    "PERMISSION_DENIED" -> "Microphone permission was denied."
    "NETWORK" -> "The Android speech service could not reach its recognition service."
    "NO_RESULT" -> "No speech was detected."
    "BUSY" -> "Voice recognition is already running."
    "CANCELLED" -> "Voice recognition was cancelled."
    else -> "Android speech recognition failed (code $error)."
  }
}

