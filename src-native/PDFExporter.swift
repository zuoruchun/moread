import Cocoa
import WebKit
import PDFKit

// Retained by the owning window until completion. The editor is never repurposed for printing.
@MainActor
public final class PDFExporter: NSObject, WKNavigationDelegate {
    private var webView: WKWebView!
    private var completion: ((Result<Void, Error>) -> Void)?
    private var targetURL: URL!
    private var timeout: Timer?
    private var preparing = false
    private var printWindow: NSWindow?
    private var temporaryURL: URL?
    private var operation: NSPrintOperation?

    public func export(html: String, filePath: String?, to url: URL,
                       completion: @escaping (Result<Void, Error>) -> Void) {
        guard self.completion == nil else {
            completion(.failure(Self.error("已有 PDF 导出正在进行")))
            return
        }
        self.completion = completion
        targetURL = url
        preparing = false
        let config = WKWebViewConfiguration()
        let localImages = LocalFileSchemeHandler()
        if let path = filePath { localImages.allowDocument(at: path) }
        config.setURLSchemeHandler(localImages, forURLScheme: "mored")
        // A private, nonpersistent browsing context also isolates remote image cookies.
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 698, height: 1027), configuration: config)
        webView.navigationDelegate = self
        let host = NSWindow(contentRect: webView.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        host.isReleasedWhenClosed = false
        host.contentView = webView
        printWindow = host
        timeout = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.finish(.failure(Self.error("PDF 排版超时，请检查图片或文档大小"))) }
        }
        webView.loadHTMLString(html, baseURL: nil)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard completion != nil, !preparing else { return }
        preparing = true
        // Wait for actual image/font readiness, with a bounded fallback for offline images.
        webView.callAsyncJavaScript("""
            const images = [...document.images];
            images.forEach(image => image.loading = 'eager');
            await Promise.race([
                Promise.all([document.fonts.ready, ...images.map(image => image.complete ? Promise.resolve() :
                    new Promise(resolve => { image.onload = resolve; image.onerror = resolve; }))]),
                new Promise(resolve => setTimeout(resolve, 10000))
            ]);
            for (const image of images) {
                if (!image.complete || !image.naturalWidth) {
                    const fallback = document.createElement('p');
                    fallback.textContent = '[图片未能加载：' + (image.alt || '无描述') + ']';
                    image.replaceWith(fallback);
                }
            }
            // WebKit otherwise moves an entire long code block off a page or clips it.
            const pageHeight = 1026;
            document.querySelectorAll('.code-block-container, blockquote, .math-block-wrapper, tr').forEach(block => {
                if (block.getBoundingClientRect().height > pageHeight) block.classList.add('pdf-splittable');
            });
            return true;
            """, arguments: [:], in: nil, in: .page) { [weak self] result in
                guard let self, self.completion != nil else { return }
                switch result {
                case .failure(let error): self.finish(.failure(error))
                case .success: self.printDocument()
                }
            }
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    private func printDocument() {
        timeout?.invalidate()
        let temporaryURL = FileManager.default.temporaryDirectory.appendingPathComponent("moread-pdf-\(UUID().uuidString).pdf")
        self.temporaryURL = temporaryURL
        let info = NSPrintInfo(dictionary: [:])
        info.paperSize = NSSize(width: 595.28, height: 841.89)
        info.orientation = .portrait
        info.leftMargin = 36
        info.rightMargin = 36
        info.topMargin = 36
        info.bottomMargin = 36
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        info.scalingFactor = 1
        info.jobDisposition = .save
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = temporaryURL
        info.dictionary()[NSPrintInfo.AttributeKey.headerAndFooter] = false
        info.dictionary()[NSPrintInfo.AttributeKey.allPages] = true
        let operation = webView.printOperation(with: info)
        self.operation = operation
        operation.showsPrintPanel = false
        operation.showsProgressPanel = false
        operation.runModal(for: printWindow!, delegate: self, didRun: #selector(printCompleted(_:success:context:)), contextInfo: nil)
    }

    @objc nonisolated private func printCompleted(_ operation: NSPrintOperation, success: Bool, context: UnsafeMutableRawPointer?) {
        // AppKit may invoke its print delegate on the printing thread, not the UI thread.
        DispatchQueue.main.async { [weak self] in self?.completePDF(success: success) }
    }

    private func completePDF(success: Bool) {
        guard completion != nil, let temporaryURL else { return }
        guard success else {
            finish(.failure(Self.error("系统未能完成 PDF 打印")))
            return
        }
        do {
            let data = try Data(contentsOf: temporaryURL)
            guard let pdf = PDFDocument(data: data), pdf.pageCount > 0 else {
                throw Self.error("生成的 PDF 无效，未覆盖目标文件")
            }
            // Publish only a complete PDF. Failed preparation/printing preserves an existing target.
            try data.write(to: targetURL, options: .atomic)
            finish(.success(()))
        } catch { finish(.failure(error)) }
    }

    private func finish(_ result: Result<Void, Error>) {
        guard let callback = completion else { return }
        completion = nil
        timeout?.invalidate()
        timeout = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView = nil
        operation = nil
        printWindow?.close()
        printWindow = nil
        if let temporaryURL { try? FileManager.default.removeItem(at: temporaryURL) }
        temporaryURL = nil
        callback(result)
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "com.moread.pdf", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
