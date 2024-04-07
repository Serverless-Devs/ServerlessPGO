## Introduction

PGO (Profile Guided Optimization) is a technique that optimizes based on runtime profiling data. It enhances the startup time of Node.js applications by several factors through the following two aspects:

### 1. Acceleration of require Relationships

When using `require` to import a module `a` in one file, it goes through a series of path resolutions to obtain the absolute path of the `a` module file. Similarly, when `require`-ing the same module `a` in another file, the resolved absolute path may differ. PGO maps the results of various `require` calls across different files to establish a two-dimensional map of relationships. With this relationship data, the `require` function is modified to include a logic that checks the mapping before the path resolution. If a corresponding relationship is found in the map, it directly returns the associated content; otherwise, it falls back to the original path resolution logic, thereby achieving acceleration.

### 2. File Caching for require

Repeatedly checking for file existence and repeatedly reading fragmented files are common operations in the `require` logic. PGO's `Require Cache` not only stores the aforementioned relationships but also:

1. Textual information of the source files.
2. V8 byte code compiled from the source files.

All this information is structured and stored in a cache file. By loading this cache file at process startup, there is no need for any deserialization step, enabling direct use of the map.

With this file, we only need to load the cache file once at the beginning of the process. Then, each time a module is `require`-d, it directly retrieves the corresponding file from the cache, fetches the source code text and its byte code from the cache, and loads them directly.

By relying on this mechanism, we save:

+ Path resolution time (repeated `statx`, more complex encapsulation logic in Node.js);
+ File reading time (repeated `openat`, more complex encapsulation logic in Node.js);
+ Compilation and execution of source code text reduced to byte code compilation and execution.


## How to Use?

PGO is currently integrated with [Serverless Devs](https://www.serverless-devs.com/en/). It can be directly used through Serverless Devs' `s cli`.

1. Add `pre-deploy` in the `service actions` of `s.yaml`, and configure the `run` command to `s cli pgo`, as shown in the image below.

![Configuration Example](https://gw.alicdn.com/imgextra/i2/O1CN01I1r4Px1zLjaHcU0ZD_!!6000000006698-2-tps-1646-642.png)

2. Change the `runtime` in `s.yaml` to `nodejs14`.

3. Deploy the function.
```shell
s deploy
```

4. Invoke function
```shell
s cli fc-api invokeFunction --serviceName fctest --functionName functest1 --event '{}'
```

## Parameters

Parameters can be passed using `s cli pgo gen --parameter key parameter value`.

+ `remove-nm`: Automatically removes `node_modules` after PGO build, `s cli pgo gen --remove-nm`.

## Detailed Generation Process
#### 1. Generate PGO File Based on Current Project Code
![](https://gw.alicdn.com/imgextra/i2/O1CN01XHeTqp1cXsvsuRAyq_!!6000000003611-2-tps-1164-930.png)
#### 2. Store the Generated PGO File in the Project Directory
![](https://gw.alicdn.com/imgextra/i2/O1CN01xp4Du11Xq8dg742js_!!6000000002974-2-tps-1050-629.png)
#### 3. Use PGO File Online to Accelerate Startup
![](https://gw.alicdn.com/imgextra/i4/O1CN01OGG21g1VhJmLQlEAS_!!6000000002684-2-tps-886-506.png)


---

Alibaba Node.js Architecture
