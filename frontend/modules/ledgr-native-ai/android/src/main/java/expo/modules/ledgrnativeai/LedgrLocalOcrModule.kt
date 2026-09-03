package expo.modules.ledgrnativeai

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.max
import kotlin.math.min

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
            val text = formattedOcrText(result)
            if (text.isEmpty()) promise.reject("ERR_NO_TEXT", "Local OCR did not detect readable text.", null)
            else promise.resolve(text)
          }
          .addOnFailureListener { error -> promise.reject("ERR_LOCAL_OCR", error.message ?: "Local OCR failed.", error) }
      } catch (error: Exception) {
        promise.reject("ERR_LOCAL_OCR_INPUT", error.message ?: "Could not read the selected image.", error)
      }
    }

    AsyncFunction("recognizePdf") { uri: String, maxPages: Int, promise: Promise ->
      val pageLimit = max(1, min(maxPages, 8))
      var descriptor: ParcelFileDescriptor? = null
      var renderer: PdfRenderer? = null
      try {
        descriptor = context.contentResolver.openFileDescriptor(Uri.parse(uri), "r")
          ?: throw IllegalStateException("Could not open the PDF.")
        renderer = PdfRenderer(descriptor)
        val activeRenderer = renderer
        val client = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        val texts = mutableListOf<String>()
        val count = min(activeRenderer.pageCount, pageLimit)
        fun finish(error: Exception? = null, empty: Boolean = false) {
          try { renderer?.close() } catch (_: Exception) {}
          try { descriptor?.close() } catch (_: Exception) {}
          when {
            error != null -> promise.reject("ERR_LOCAL_OCR", error.message ?: "Local PDF OCR failed.", error)
            empty -> promise.reject("ERR_NO_TEXT", "Local OCR did not detect readable text in this PDF.", null)
            else -> promise.resolve(texts.joinToString("\n").trim())
          }
        }
        fun next(index: Int) {
          if (index >= count) {
            finish(empty = texts.none { it.isNotBlank() })
            return
          }
          val page = activeRenderer.openPage(index)
          val width = 1280
          val height = max(1, (page.height.toFloat() / page.width * width).toInt())
          val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
          bitmap.eraseColor(Color.WHITE)
          page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
          page.close()
          client.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { result ->
              bitmap.recycle()
              val text = formattedOcrText(result)
              if (text.isNotEmpty()) texts.add(text)
              next(index + 1)
            }
            .addOnFailureListener { error ->
              bitmap.recycle()
              finish(error)
            }
        }
        next(0)
      } catch (error: Exception) {
        try { renderer?.close() } catch (_: Exception) {}
        try { descriptor?.close() } catch (_: Exception) {}
        promise.reject("ERR_LOCAL_OCR_INPUT", error.message ?: "Could not read the PDF.", error)
      }
    }
  }

  /**
   * Rebuilds reading-order text so right-aligned amounts stay on the same line
   * as their labels. ML Kit's default `result.text` dumps columns separately,
   * which made closing reports collapse to one total.
   */
  private fun formattedOcrText(result: com.google.mlkit.vision.text.Text): String {
    data class Piece(val left: Int, val top: Int, val bottom: Int, val text: String)
    val pieces = mutableListOf<Piece>()
    for (block in result.textBlocks) {
      for (line in block.lines) {
        val box = line.boundingBox ?: continue
        val text = line.text.trim()
        if (text.isNotEmpty()) pieces.add(Piece(box.left, box.top, box.bottom, text))
      }
    }
    if (pieces.isEmpty()) return result.text.trim()
    pieces.sortWith(compareBy({ it.top }, { it.left }))
    val rows = mutableListOf<MutableList<Piece>>()
    for (piece in pieces) {
      val row = rows.lastOrNull()
      val mid = (piece.top + piece.bottom) / 2
      if (row != null) {
        val rowMid = (row.minOf { it.top } + row.maxOf { it.bottom }) / 2
        val height = max(1, max(piece.bottom - piece.top, row.maxOf { it.bottom } - row.minOf { it.top }))
        if (kotlin.math.abs(mid - rowMid) <= height * 0.6f) {
          row.add(piece)
          continue
        }
      }
      rows.add(mutableListOf(piece))
    }
    return rows.joinToString("\n") { row ->
      row.sortBy { it.left }
      row.joinToString(" ") { it.text }
    }.trim()
  }
}
