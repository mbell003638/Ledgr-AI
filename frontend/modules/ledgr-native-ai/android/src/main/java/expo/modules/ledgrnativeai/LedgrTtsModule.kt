package expo.modules.ledgrnativeai

import android.speech.tts.TextToSpeech
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

class LedgrTtsModule : Module(), TextToSpeech.OnInitListener {
  private var tts: TextToSpeech? = null
  private var ready = false

  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("LedgrTts")

    OnCreate {
      tts = TextToSpeech(context, this@LedgrTtsModule)
    }

    OnDestroy {
      tts?.stop()
      tts?.shutdown()
      tts = null
      ready = false
    }

    AsyncFunction("isAvailable") {
      ready && tts != null
    }

    AsyncFunction("speak") { text: String ->
      val engine = tts ?: throw IllegalStateException("Phone speaker is not ready.")
      if (!ready) throw IllegalStateException("No text-to-speech voice is installed on this phone.")
      val spoken = text.trim()
      if (spoken.isEmpty()) return@AsyncFunction
      engine.speak(spoken.take(600), TextToSpeech.QUEUE_FLUSH, null, "ledgr-tts")
    }

    AsyncFunction("stop") {
      tts?.stop()
    }
  }

  override fun onInit(status: Int) {
    ready = status == TextToSpeech.SUCCESS
    if (ready) tts?.language = Locale.getDefault()
  }
}
