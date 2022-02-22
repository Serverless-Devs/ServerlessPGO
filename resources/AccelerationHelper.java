import com.aliyun.fc.runtime.Context;
import com.aliyun.fc.runtime.HttpRequestHandler;

import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

public class AccelerationHelper implements HttpRequestHandler {
    private static final String KEY_FILE = "file";
    private static final String KEY_TYPE = "type";
    private static final String KEY_START = "start";
    private static final String KEY_SIZE = "size";
    private static final String KEY_SRPATH = "srpath";
    private static final String DUMP = "dump";
    private static final String SIZE = "size";
    private static final String QUICKSTART = "/code/quickstart.sh";

    @Override
    public void handleRequest(HttpServletRequest request, HttpServletResponse response, Context context)
            throws IOException, ServletException {
        String data;
        try {
            data = _handleRequest(request);
            response.setStatus(200);
        } catch (Exception e) {
            response.setStatus(500);
            data = "Exception:" + e.getMessage() + "\n" + Arrays.toString(e.getStackTrace());
        }

        response.setHeader("Content-Type", "text/plain");
        OutputStream out = response.getOutputStream();
        out.write((data).getBytes());
        out.flush();
        out.close();
    }

    public String _handleRequest(HttpServletRequest request) throws Exception {
        String event = getBodyText(request);
        Map<String, String> map = parseBody(event);
        String filePath = map.get(KEY_FILE);

        String data = "";
        if (DUMP.equals(map.get(KEY_TYPE))) {
            String srpath = map.get(KEY_SRPATH);
            data = dumpByJcmd(srpath, filePath);
            return data;
        }

        File file = new File(filePath);
        if (SIZE.equals(map.get(KEY_TYPE))) {
            data += String.valueOf(file.length());
            return data;
        }

        long start = Long.parseLong(map.get(KEY_START));
        int size = Integer.parseInt(map.get(KEY_SIZE));
        data = readFile(file, start, size);

        return data;
    }

    private static String dumpByJcmd(String srpath, String filePath) throws IOException, InterruptedException {
        String javaHome = System.getProperty("java.home");
        long pid = ProcessHandle.current().pid();

        ProcessBuilder pbDump = new ProcessBuilder(QUICKSTART, "dump", javaHome, String.valueOf(pid));
        Process pDump = pbDump.start();
        int exitValue = pDump.waitFor();
        String data = readStdAndErrorOutput(pDump);

        if (exitValue == 0) {
            data += String.format("Acceleration file list: \n%s", listDir(srpath, 0));
            if (filePath != null && filePath.length() > 0) {
                try {
                    data += doSave(srpath, filePath);
                } catch (Exception e) {
                    return e.getMessage() + "\n" + genDiagnosticInfo();
                }
            }
            data = "success," + data;
        } else {
            data += "dump error\n\n";
            data += genDiagnosticInfo();
        }
        return data;
    }

    private static String doSave(String srpath, String fileName) throws IOException, InterruptedException {
        ProcessBuilder pbSave = new ProcessBuilder(QUICKSTART, "save", srpath, fileName);
        Process pSave = pbSave.start();
        int exitValue = pSave.waitFor();
        String output = readStream(pSave.getInputStream());
        String data;
        if (exitValue == 0) {
            data = "archive file created: [" + (new File(fileName).exists() ? fileName : "") + "]";
        } else {
            throw new RuntimeException("save error: " + output);
        }
        return data;
    }

    private static String genDiagnosticInfo() throws IOException {
        StringBuilder data = new StringBuilder("environment variables\n");
        Map<String, String> env = System.getenv();
        for (String envName : env.keySet()) {
            data.append(String.format("%s=%s%n", envName, env.get(envName)));
        }
        data.append("\nbootstrap.sh:\n");
        data.append(readFile("/var/fc/runtime/java11/bootstrap.sh"));
        return data.toString();
    }

    private static String readStdAndErrorOutput(Process p) throws IOException {
        String output = "\nstdout of dump:\n";
        output += readStream(p.getInputStream());
        String errOutput = readStream(p.getErrorStream());
        if (errOutput.length() > 0) {
            output += "\nstderr of dump:\n" + errOutput;
        }
        return output;
    }

    private static String readStream(InputStream s) throws IOException {
        InputStreamReader reader = new InputStreamReader(s);
        BufferedReader b = new BufferedReader(reader);
        StringBuilder buffer = new StringBuilder();
        while (true) {
            String line = b.readLine();
            if (line == null) {
                break;
            }
            buffer.append(line).append("\n");
        }

        return buffer.toString();
    }

    private static String readFile(File file, long start, int size) throws IOException {
        FileInputStream fis = new FileInputStream(file);
        ByteBuffer buffer = ByteBuffer.allocate(size);
        int total = 0;
        try {
            do {
                int read = fis.getChannel().read(buffer, start);
                total += read;
            } while (total != size);
        } finally {
            fis.close();
        }

        return Base64.getEncoder().encodeToString(buffer.array());
    }

    private static String readFile(String fileName) throws IOException {
        FileInputStream fis = new FileInputStream(fileName);
        BufferedReader br = new BufferedReader(new InputStreamReader(fis));
        StringBuilder b = new StringBuilder();
        try {
            while (true) {
                String line = br.readLine();
                if (line == null) {
                    break;
                }
                b.append(line).append("\n");
            }
        } finally {
            fis.close();
        }

        return b.toString();
    }

    private static Map<String, String> parseBody(String body) {
        final Map<String, String> map = new HashMap<>();
        String[] arr = body.split(";");
        if (arr.length != 0) {
            Arrays.stream(arr).forEach(item -> {
                String[] pair = item.split("=");
                if (pair.length == 1) {
                    pair = new String[] {pair[0], ""};
                }
                if (pair[0] != null && pair[0].length() > 0) {
                    map.put(pair[0], pair[1]);
                }
            });
        }
        return map;
    }

    private static String getBodyText(HttpServletRequest request) throws IOException {
        BufferedReader br = request.getReader();
        String str;
        StringBuilder wholeStr = new StringBuilder();
        while((str = br.readLine()) != null) {
            wholeStr.append(str);
        }
        return wholeStr.toString();
    }

    private static String listDir(String dir, int indent) {
        if (indent > 3) {
            return "";
        }

        File[] files = new File(dir).listFiles();
        if (files == null) {
            return "";
        }

        StringBuilder s = new StringBuilder();
        for (File file : files) {
            s.append("    ".repeat(Math.max(0, indent))).append(file.getName()).append("\n");
            if (file.isDirectory()) {
                s.append(listDir(file.getAbsolutePath(), indent + 1));
            }

        }

        return s.toString();
    }
}
