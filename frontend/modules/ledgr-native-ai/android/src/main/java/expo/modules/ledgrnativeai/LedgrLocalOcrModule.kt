package expo.modules.ledgrnativeai

import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LedgrLocalOcrModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("LedgrLocalOcr")

    AsyncFunction("isAvailable") { true }

    AsyncFunction("recognize") { uri: String, _language: String?, promise: Promise ->
      try {
        val image = InputImage.fromFilePath(context, Uri.parse(uri))
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
          .process(image)
          .addOnSuccessListener { result ->
            val text = result.text.trim()
            if (text.isEmpty()) promise.reject("ERR_NO_TEXT", "Local OCR did not detect readable text.", null)
            else promise.resolve(text)
          }
          .addOnFailureListener { error -> promise.reject("ERR_LOCAL_OCR", error.message ?: "Local OCR failed.", error) }
      } catch (error: Exception) {
        promise.reject("ERR_LOCAL_OCR_INPUT", error.message ?: "Could not read the selected image.", error)
      }
    }
  }
}
