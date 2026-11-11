import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.yl.ddddocr.OCREngine;

import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/** Development-only loopback adapter for the local ddddocr4j model used by the legacy project. */
public final class LocalOcrServer {
    public static void main(String[] args) throws Exception {
        int port = args.length == 0 ? 17891 : Integer.parseInt(args[0]);
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 0);
        server.createContext("/ocr", LocalOcrServer::recognize);
        server.start();
        System.out.println("READY " + port);
    }

    private static void recognize(HttpExchange exchange) {
        try (exchange) {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                respond(exchange, 405, "{\"error\":\"method not allowed\"}");
                return;
            }
            JSONObject request = JSON.parseObject(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] image = Base64.getDecoder().decode(request.getString("image"));
            BufferedImage original = ImageIO.read(new ByteArrayInputStream(image));
            if (original == null) {
                throw new IllegalArgumentException("unsupported image");
            }
            BufferedImage gray = toGray(original);
            BufferedImage[] variants = new BufferedImage[] {
                    original, gray, scale(original, 2.0), scale(gray, 2.0)
            };
            String code = "";
            for (BufferedImage variant : variants) {
                String candidate = OCREngine.instance().recognize(variant);
                if (candidate != null && !candidate.isBlank()) {
                    code = candidate.trim();
                    if (isMathExpression(code)) {
                        break;
                    }
                }
            }
            JSONObject response = new JSONObject();
            response.put("code", code);
            respond(exchange, 200, response.toJSONString());
        } catch (Exception error) {
            try { respond(exchange, 500, "{\"error\":\"recognition failed\"}"); } catch (Exception ignored) { }
        }
    }

    private static boolean isMathExpression(String value) {
        return value.matches(".*\\d\\s*[+\\-*/×xX÷]\\s*\\d.*");
    }

    private static BufferedImage toGray(BufferedImage source) {
        BufferedImage gray = new BufferedImage(source.getWidth(), source.getHeight(), BufferedImage.TYPE_BYTE_GRAY);
        Graphics2D graphics = gray.createGraphics();
        graphics.drawImage(source, 0, 0, null);
        graphics.dispose();
        return gray;
    }

    private static BufferedImage scale(BufferedImage source, double factor) {
        int width = (int) (source.getWidth() * factor);
        int height = (int) (source.getHeight() * factor);
        int type = source.getType() == BufferedImage.TYPE_CUSTOM ? BufferedImage.TYPE_3BYTE_BGR : source.getType();
        BufferedImage scaled = new BufferedImage(width, height, type);
        Graphics2D graphics = scaled.createGraphics();
        graphics.drawImage(source, 0, 0, width, height, null);
        graphics.dispose();
        return scaled;
    }

    private static void respond(HttpExchange exchange, int status, String body) throws Exception {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }
}
