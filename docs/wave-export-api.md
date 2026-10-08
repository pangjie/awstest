# 波次 Excel 下载

本次修改尚未部署；以下线上链接需部署后才能使用。

## 下载链接

默认使用第一套网站：[下载 2026-10-01 的波次 Excel](https://dldvn9qewx9fn.cloudfront.net/api/v1/exports/waves?date=2026-10-01)

只需更换 `date=YYYY-MM-DD`。无需登录、密钥或特殊请求头。

第二套网站：[下载示例](https://d2qp1vcdt9xlv1.cloudfront.net/api/v1/exports/waves?date=2026-10-01)

导出美东时间当天**创建**的波次，一行一个，保留负责人、协同人员等全部原导出字段。工时为这些波次截至下载时的累计有效工时，不限于当天。

“开始时间”和“完结时间”使用 UTC 零时区 ISO 8601 文本，精确到秒，例如 `2026-10-08T14:30:00Z`；没有时间的单元格留空。日期筛选和每日配额重置仍使用美东时区。

## 各语言调用

以下示例均下载第一套网站 2026-10-01 的数据。

### curl

```sh
curl --fail --output waves.xlsx "https://dldvn9qewx9fn.cloudfront.net/api/v1/exports/waves?date=2026-10-01"
```

### Python（标准库）

```python
from urllib.request import urlopen
url = "https://dldvn9qewx9fn.cloudfront.net/api/v1/exports/waves?date=2026-10-01"
with urlopen(url, timeout=45) as response:
    with open("waves.xlsx", "wb") as file:
        file.write(response.read())
```

### JavaScript / Node.js 22+

```js
import { writeFile } from "node:fs/promises";
const response = await fetch("https://dldvn9qewx9fn.cloudfront.net/api/v1/exports/waves?date=2026-10-01");
if (!response.ok) throw new Error(await response.text());
await writeFile("waves.xlsx", Buffer.from(await response.arrayBuffer()));
```

### C# / .NET 8+

```csharp
using var client = new HttpClient();
var bytes = await client.GetByteArrayAsync("https://dldvn9qewx9fn.cloudfront.net/api/v1/exports/waves?date=2026-10-01");
await File.WriteAllBytesAsync("waves.xlsx", bytes);
```

### Java 11+

```java
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
class Download {
    public static void main(String[] args) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(
            "https://dldvn9qewx9fn.cloudfront.net/api/v1/exports/waves?date=2026-10-01")).GET().build();
        var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode() != 200) throw new RuntimeException(new String(response.body()));
        Files.write(Path.of("waves.xlsx"), response.body());
    }
}
```

### PHP（cURL 扩展）

```php
<?php
$ch = curl_init("https://dldvn9qewx9fn.cloudfront.net/api/v1/exports/waves?date=2026-10-01");
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 45]);
$data = curl_exec($ch);
if ($data === false || curl_getinfo($ch, CURLINFO_HTTP_CODE) !== 200) {
    throw new RuntimeException(curl_error($ch) ?: $data);
}
curl_close($ch);
file_put_contents("waves.xlsx", $data);
```

### PowerShell

```powershell
Invoke-WebRequest -Uri "https://dldvn9qewx9fn.cloudfront.net/api/v1/exports/waves?date=2026-10-01" -OutFile "waves.xlsx"
```

## 限制与错误

- 每套网站所有访问者共用：每日 100 次、滚动一分钟 6 次、同时生成 1 份。每日额度按美东午夜重置，重启不重置；进入生成流程后失败也计次。
- 每次最多 20,000 个波次、20 MiB；没有匹配波次时返回仅有表头的 Excel。
- `400`：日期不合法；`422`：数据过大；`429`：超限或正在生成，请按响应头 `Retry-After` 的秒数等待；`503`：暂时不可用。
- 响应头 `X-Export-Site-Remaining` 为当日剩余额度，`X-Export-Reset` 为重置时间。
- 这是公开只读链接，任何人可下载，包括员工姓名。限流不是访问认证，也不能保证 AWS 账单封顶。网站其他页面仍保留原有登录和权限要求。
