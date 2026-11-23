using System.IO;
using System.Text;
using System.Text.Json;

namespace SleepwalkerNative;

public class NativeMessagingHost
{
    private const int MaxMessageLength = 1024 * 1024; // 1 MB per Chrome spec
    private readonly Stream _inputStream;
    private readonly Stream _outputStream;
    private readonly BinaryReader _reader;
    private readonly BinaryWriter _writer;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    public NativeMessagingHost(Stream inputStream, Stream outputStream)
    {
        _inputStream = inputStream;
        _outputStream = outputStream;
        _reader = new BinaryReader(_inputStream);
        _writer = new BinaryWriter(_outputStream);
    }

    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            NativeRequest? request = null;
            try
            {
                // 1. Read 4-byte little-endian length prefix
                byte[] lengthBytes = new byte[4];
                int bytesRead = await ReadExactBytesAsync(_inputStream, lengthBytes, 4, cancellationToken);
                if (bytesRead < 4)
                {
                    // Stream closed / EOF from Chrome
                    break;
                }

                uint messageLength = BitConverter.ToUInt32(lengthBytes, 0);
                if (messageLength == 0)
                {
                    continue;
                }

                if (messageLength > MaxMessageLength)
                {
                    // Exceeded max payload size
                    var errResp = NativeResponse.CreateError("unknown", "INVALID_REQUEST", $"Payload length {messageLength} exceeds maximum permitted 1MB", 0);
                    WriteResponse(errResp);
                    continue;
                }

                // 2. Read exact message bytes
                byte[] buffer = new byte[messageLength];
                bytesRead = await ReadExactBytesAsync(_inputStream, buffer, (int)messageLength, cancellationToken);
                if (bytesRead < messageLength)
                {
                    // Incomplete payload before stream ended
                    break;
                }

                string jsonString = Encoding.UTF8.GetString(buffer);
                request = JsonSerializer.Deserialize<NativeRequest>(jsonString, JsonOptions);

                if (request == null)
                {
                    var errResp = NativeResponse.CreateError("unknown", "INVALID_REQUEST", "Failed to deserialize JSON payload", 0);
                    WriteResponse(errResp);
                    continue;
                }

                // 3. Dispatch and execute
                var response = await ActionExecutor.ExecuteAsync(request, cancellationToken);
                WriteResponse(response);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (EndOfStreamException)
            {
                break;
            }
            catch (Exception ex)
            {
                string reqId = request?.RequestId ?? "error";
                var errResp = NativeResponse.CreateError(reqId, "FAILED", ex.Message, 0);
                try
                {
                    WriteResponse(errResp);
                }
                catch
                {
                    break;
                }
            }
        }
    }

    private void WriteResponse(NativeResponse response)
    {
        lock (_writer)
        {
            string json = JsonSerializer.Serialize(response, JsonOptions);
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            uint length = (uint)bytes.Length;

            _writer.Write(length);
            _writer.Write(bytes);
            _writer.Flush();
            _outputStream.Flush();
        }
    }

    private static async Task<int> ReadExactBytesAsync(Stream stream, byte[] buffer, int count, CancellationToken ct)
    {
        int totalRead = 0;
        while (totalRead < count)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(totalRead, count - totalRead), ct);
            if (read == 0)
            {
                // EOF reached
                return totalRead;
            }
            totalRead += read;
        }
        return totalRead;
    }
}
