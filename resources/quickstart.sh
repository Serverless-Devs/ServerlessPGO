#!/bin/bash

echo "origin command line: $*"

get_release_file() {
    java_path=$1
    suffix="/bin/java"
    if [[ "$java_path" != *"$suffix" ]]; then
        echo "can not detect JAVA_HOME"
        return 1
    fi

    release_file="${java_path%$suffix}/release"

    if [ ! -f "$release_file" ]; then
        echo "$release_file does not exist."
        return 1
    fi

    echo "$release_file"
    return 0
}

check_special_version () {
    if result=$(get_release_file "$1"); then
        echo "detected release file: $result"
        release_file=$result
    else
        echo "$result"
        return 1
    fi

    FULL_VERSION=$(cat < "$release_file"|grep 'FULL_VERSION='|cut -d '"' -f 2)
    if [ -z "$FULL_VERSION" ]; then
        echo "can not detect full version"
        return 1
    else
        echo "Java full version $FULL_VERSION"
    fi

    if [[ "$FULL_VERSION" == *"11.0.14.13-AJDKfp1"* ]]; then
        return 1
    fi

    if [[ "$FULL_VERSION" == *"11.0.14.13-AJDKfp2"* ]]; then
        return 1
    fi

    return 0
}

check_java () {
	if result=$(get_release_file "$1"); then
		echo "detected release file: $result"
        release_file=$result
	else
		echo "$result"
		return 1
	fi

    if ! grep -q 'IMPLEMENTOR_VERSION="(Alibaba AJDK)"' "$release_file"; then
        echo "current Java release is not Alibaba AJDK"
        return 1
    fi

    if ! grep -q 'JAVA_VERSION="11.' "$release_file"; then
		echo "current Java version is not Alibaba AJDK 11"
		return 1
	fi

	echo "check Java: passed"
    return 0
}

check_srpath () {
	if [[ -z "${SRPATH}" ]]; then
		echo "env var SRPATH should be set"
		return 1
	else
		srpath="${SRPATH}"
		if [ ! -d "$srpath" ]; then
			if mkdir -p $srpath; then
				echo "dir $srpath created"
			else
				echo "dir $srpath creating encountered error"
				return 1
			fi
		fi
	fi

	echo "check SRPATH: passed"
	return 0
}

run () {
	enabled_features="+eagerappcds"
	if [[ $1 == "--quickstart="* ]] ; then
		features="${1#*=}"
		shift
		if [[ -n "$features" ]]; then
			enabled_features=$features
		fi
	fi

	echo "quickstart.sh: enable features $enabled_features"

	java_command=$1
	if ! check_java "$java_command" || ! check_srpath; then
		echo "run java without quickstart"
		exec "$@"
		exit $?
	fi

	check_special_version "$java_command"
	special=$?

    args=()
    i=1;
    j=$#;
    while [ $i -le $j ]
    do
        current=$i
        i=$((i + 1));
        item=$1
        shift 1;

        if [[ $item == "-Xquickstart"* ]] ;
        then
            continue
        fi

        args+=( "$item" )

        if [[ $current == 1 ]] ;
        then
            args+=( "-Xquickstart:verbose,$enabled_features,path=$srpath" )
            args+=( "-XX:+IgnoreAppCDSDirCheck" )
            args+=( "-Xbootclasspath/a:/code/sr" )
            args+=( "-Xlog:class+eagerappcds=trace:file=/tmp/classloader.log" )
			if [[ $special == 1 ]]; then
				args+=( "-XX:-AutoAppAOTBinding" )
				args+=( "-XX:-UseAppAOT" )
			fi
        fi

    done

    echo "final command line: ${args[*]}"
    exec "${args[@]}"
}

dump () {
    java_home=$1
    jcmd="$1/bin/jcmd"
    pid=$2

    if [ ! -d "$java_home" ]
    then
        echo "invalid JAVA_HOME [$java_home]"
        exit 1
    fi

    if [ ! -f "$jcmd" ]; then
        echo "command file [$jcmd] does not exist"
        exit 1
    fi

    echo "run command line: $jcmd $pid QuickStart.dump"
    exec "$jcmd" "$pid" QuickStart.dump
}

save () {
    if ! command -v "tar" &> /dev/null
    then
        echo "command [tar] could not be found"
        exit 1
    fi
    srpath=$1
    zip_file_path=$2

    if [ ! -d "$srpath" ]
    then
        echo "srpath [$srpath] does not exist, the bootstrap_wrapper may not take effect"
        exit 1
    fi

    cd "$srpath"
    echo "tar -czf $zip_file_path ."
    exec tar -czf $zip_file_path .
}

mode=$1

case "$mode" in
    'dump')
        if [[ $# -lt 3 ]]; then
            echo "arguments not enough, required 3 but got $#"
            exit 1
        fi
        dump "$2" "$3"
        ;;
    'save')
        if [[ $# -lt 3 ]]; then
            echo "arguments not enough, required 3 but got $#"
            exit 1
        fi
        save "$2" "$3"
        ;;
    *)
        run "$@"
        ;;
esac

exit 0
